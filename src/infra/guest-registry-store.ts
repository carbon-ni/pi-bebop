import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import {
	GUEST_REGISTRY_VERSION,
	isGuestRegistryFile,
	nextGuestRegistryRevision,
	type CrewSelector,
	type GuestRegistryEntry,
	type GuestRegistryFile,
} from "../domain/index.ts";

/**
 * Crew-owned durable Guest registry (TASK-0161 dependency fix).
 *
 * The registry lives next to the trusted crew manifest and is authoritative
 * across every Member runtime: admission tombstones (pending/approved/denied/
 * revoked) are written here instead of session-private entries, so approvals,
 * revocations, and `/crew guests` state are consistent crew-wide.
 *
 * Writes are atomic (temp file + rename) with a revision compare-and-retry so
 * concurrent Members never lose tombstones. Reading fails closed on tampered
 * content, foreign crew bindings, loose file permissions, and non-canonical
 * crew paths. Plaintext capabilities are never persisted: approved entries
 * carry only a verifier digest of the runtime-held capability.
 */

export type GuestRegistryErrorCode = "untrusted-path" | "tampered" | "permission" | "conflict" | "io";

export class GuestRegistryError extends Error {
	readonly code: GuestRegistryErrorCode;

	constructor(code: GuestRegistryErrorCode, message: string) {
		super(message);
		this.name = "GuestRegistryError";
		this.code = code;
	}
}

const REGISTRY_FILE_NAME = "guest-registry.json";
const TEMP_PREFIX = ".tmp-guest-registry-";
const MAX_WRITE_ATTEMPTS = 4;

/** Verifier digest of a runtime-held capability; plaintext never lands on disk. */
export function digestGuestCapability(capability: string): string {
	return crypto.createHash("sha256").update(capability, "utf8").digest("hex");
}

/** Registry path as a sibling of the trusted crew manifest; fails closed elsewhere. */
export function getCrewGuestRegistryPath(manifestPath: string): string {
	const normalized = path.resolve(manifestPath);
	const layoutDir = path.dirname(normalized);
	const piDir = path.dirname(layoutDir);
	const valid =
		path.basename(normalized) === "crew.json" &&
		(path.basename(layoutDir) === "bebop" || path.basename(layoutDir) === "crew") &&
		path.basename(piDir) === ".pi";
	if (!valid) throw new GuestRegistryError("untrusted-path", `crew registry path is not canonical: ${manifestPath}`);
	return path.join(layoutDir, REGISTRY_FILE_NAME);
}

export interface GuestRegistrySnapshot {
	readonly status: "approved" | "denied" | "revoked";
	readonly record?: {
		readonly crew: CrewSelector;
		readonly guestIdentity: string;
		readonly guestName: string;
		readonly callbackEndpoint: string;
		readonly approvedBy: string;
	};
	readonly request?: {
		readonly crew: CrewSelector;
		readonly guestIdentity: string;
		readonly guestName: string;
		readonly callbackEndpoint: string;
	};
	/** Verifier digest of the runtime-held capability; approved entries only. */
	readonly capabilityDigest?: string;
	/** The Member who denied the request; denied entries only. */
	readonly approver?: string;
}

export interface GuestRegistryStoreDeps {
	readonly readFileSync: (filePath: string, encoding: "utf8") => string;
	readonly writeFileSync: (filePath: string, data: string, options: { encoding: "utf8"; mode: number }) => void;
	readonly renameSync: (from: string, to: string) => void;
	readonly statSync: (filePath: string) => { mode: number };
	readonly unlinkSync: (filePath: string) => void;
}

const defaultDeps: GuestRegistryStoreDeps = {
	readFileSync: (filePath, encoding) => fsSync.readFileSync(filePath, encoding),
	writeFileSync: (filePath, data, options) => fsSync.writeFileSync(filePath, data, options),
	renameSync: (from, to) => fsSync.renameSync(from, to),
	statSync: (filePath) => fsSync.statSync(filePath),
	unlinkSync: (filePath) => fsSync.unlinkSync(filePath),
};

export interface GuestRegistryStore {
	/** Canonical registry file path. */
	readonly path: string;
	/** Authoritative snapshot; an absent file reads as an empty revision-0 registry. */
	load(): GuestRegistryFile;
	/**
	 * Replaces the tombstone set with the given snapshots using a revision
	 * compare-and-retry so concurrent Members never lose each other's writes.
	 */
	replaceEntries(snapshots: readonly GuestRegistrySnapshot[]): GuestRegistryFile;
}

function entryFromSnapshot(snapshot: GuestRegistrySnapshot, order: number, revision: number): GuestRegistryEntry {
	const base = {
		crew: snapshot.record?.crew ?? snapshot.request!.crew,
		guestIdentity: snapshot.record?.guestIdentity ?? snapshot.request!.guestIdentity,
		guestName: snapshot.record?.guestName ?? snapshot.request!.guestName,
		callbackEndpoint: snapshot.record?.callbackEndpoint ?? snapshot.request!.callbackEndpoint,
		order,
		revision,
	};
	if (snapshot.status === "denied")
		return {
			...base,
			status: "denied",
			capabilityDigest: "0".repeat(64),
			approver: snapshot.approver ?? "unknown",
		};
	return {
		...base,
		status: snapshot.status,
		capabilityDigest: snapshot.capabilityDigest ?? "0".repeat(64),
		approver: snapshot.record?.approvedBy ?? snapshot.approver ?? "unknown",
	};
}

export function createGuestRegistryStore(options: {
	manifestPath: string;
	crew: CrewSelector;
	deps?: Partial<GuestRegistryStoreDeps>;
}): GuestRegistryStore {
	const filePath = getCrewGuestRegistryPath(options.manifestPath);
	const deps = { ...defaultDeps, ...options.deps };

	function readValidated(): GuestRegistryFile {
		let raw: string;
		try {
			raw = deps.readFileSync(filePath, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT")
				return { version: GUEST_REGISTRY_VERSION, crew: options.crew, revision: 0, entries: [] };
			if (code === "EACCES" || code === "EPERM")
				throw new GuestRegistryError("permission", `crew guest registry is not readable: ${filePath}`);
			throw new GuestRegistryError("io", `crew guest registry read failed: ${String(error)}`);
		}
		const mode = deps.statSync(filePath).mode;
		if ((mode & 0o077) !== 0)
			throw new GuestRegistryError(
				"permission",
				`crew guest registry must not be group/world accessible: ${filePath}`,
			);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new GuestRegistryError("tampered", "crew guest registry is not valid JSON");
		}
		if (!isGuestRegistryFile(parsed))
			throw new GuestRegistryError("tampered", "crew guest registry failed validation");
		if (parsed.crew.id !== options.crew.id || parsed.crew.displayName !== options.crew.displayName)
			throw new GuestRegistryError("tampered", "crew guest registry belongs to a different crew");
		return parsed;
	}

	function publish(base: GuestRegistryFile, snapshots: readonly GuestRegistrySnapshot[]): GuestRegistryFile {
		const revision = nextGuestRegistryRevision(base);
		const existingByIdentity = new Map(base.entries.map((entry) => [entry.guestIdentity, entry]));
		let nextOrder = base.entries.reduce((max, entry) => Math.max(max, entry.order), 0);
		const entries = snapshots.map((snapshot) => {
			const identity = snapshot.record?.guestIdentity ?? snapshot.request!.guestIdentity;
			const existing = existingByIdentity.get(identity);
			const order = existing?.order ?? ++nextOrder;
			const candidate = entryFromSnapshot(snapshot, order, revision);
			// An untouched tombstone keeps its original write revision; only real
			// state changes advance the per-entry revision.
			if (existing) {
				const { order: _o, revision: _r, ...candidateState } = candidate;
				const { order: _eo, revision: _er, ...existingState } = existing;
				if (JSON.stringify(candidateState) === JSON.stringify(existingState)) return existing;
			}
			return candidate;
		});
		// Canonical deterministic order: by assignment order, never snapshot order.
		entries.sort((left, right) => left.order - right.order);
		return { version: GUEST_REGISTRY_VERSION, crew: options.crew, revision, entries };
	}

	function writeAtomically(next: GuestRegistryFile, baseRevision: number): GuestRegistryFile | null {
		// Compare-and-retry: if another Member wrote since our base, refresh and
		// re-apply instead of clobbering their tombstones.
		const current = readValidated();
		if (current.revision !== baseRevision) return null;
		const tempPath = path.join(path.dirname(filePath), `${TEMP_PREFIX}${process.pid}-${Date.now()}`);
		try {
			deps.writeFileSync(tempPath, `${JSON.stringify(next, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
			deps.renameSync(tempPath, filePath);
		} catch (error) {
			try {
				deps.unlinkSync(tempPath);
			} catch {
				/* temp already gone */
			}
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EPERM")
				throw new GuestRegistryError("permission", `crew guest registry is not writable: ${filePath}`);
			throw new GuestRegistryError("io", `crew guest registry write failed: ${String(error)}`);
		}
		return next;
	}

	return {
		path: filePath,
		load() {
			return readValidated();
		},
		replaceEntries(snapshots) {
			let base = this.load();
			for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
				const next = publish(base, snapshots);
				const written = writeAtomically(next, base.revision);
				if (written) return written;
				base = this.load();
			}
			throw new GuestRegistryError(
				"conflict",
				`crew guest registry stayed contested after ${MAX_WRITE_ATTEMPTS} attempts`,
			);
		},
	};
}
