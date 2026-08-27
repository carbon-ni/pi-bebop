import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
	MAX_AGREEMENT_RECORD_ID_BYTES,
	MAX_AGREEMENT_TEXT_BYTES,
	isAgreementProposal,
	isAgreementRevision,
	isAgreementRecord,
	isCurrentAgreementRevisionEligible,
	type AgreementProposal,
	type AgreementRecord,
	type AgreementRevision,
} from "../domain/index.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";
import { activate, validateRevisionReferences, readRecord } from "./crew-agreement-activation-store.ts";

export const AGREEMENTS_DIR = "agreements";
const HISTORY_DIR = "history";
const PROPOSALS_DIR = "proposals";
const REVISIONS_DIR = "revisions";
const LOCK_FILE = ".lock";
export const ACTIVATION_STATE_FILE = "activation.json";
export const ACTIVATION_JOURNAL_FILE = ".activation-pending.json";
const TEMP_PREFIX = ".tmp-";
const ACTIVATION_STATE_VERSION = 1 as const;
export const MAX_AGREEMENT_RECORD_FILE_BYTES = MAX_AGREEMENT_TEXT_BYTES * 4;
export const MAX_AGREEMENT_RECORD_COUNT = 1024;

export type CrewAgreementStoreErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "path-unsafe"
	| "invalid-proposal"
	| "invalid-revision"
	| "record-not-found"
	| "stale-base"
	| "invalid-reference"
	| "corrupt-record"
	| "record-oversized"
	| "duplicate-id"
	| "idempotency-conflict"
	| "lock-conflict"
	| "read-failed"
	| "write-failed"
	| "activation-not-configured"
	| "activation-conflict";

export class CrewAgreementStoreError extends Error {
	readonly code: CrewAgreementStoreErrorCode;

	constructor(code: CrewAgreementStoreErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CrewAgreementStoreError";
		this.code = code;
	}
}

export type Deps = {
	mkdir: (directory: string) => Promise<void>;
	readdir: (directory: string) => Promise<string[]>;
	readFile: (filePath: string) => Promise<Buffer>;
	writeFile: (filePath: string, data: string) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	unlink: (filePath: string) => Promise<void>;
	stat: (filePath: string) => Promise<{ size: number; isFile(): boolean }>;
	lstat: (filePath: string) => Promise<{ isSymbolicLink(): boolean }>;
	realpath: (filePath: string) => Promise<string>;
	openLock: (filePath: string) => Promise<() => Promise<void>>;
	lockDeadlineMs: number;
	lockPollMs: number;
};

export interface CrewAgreementStoreDependencies {
	readonly mkdir?: (directory: string) => Promise<void>;
	readonly readdir?: (directory: string) => Promise<string[]>;
	readonly readFile?: (filePath: string) => Promise<Buffer>;
	readonly writeFile?: (filePath: string, data: string) => Promise<void>;
	readonly rename?: (from: string, to: string) => Promise<void>;
	readonly unlink?: (filePath: string) => Promise<void>;
	readonly stat?: (filePath: string) => Promise<{ size: number; isFile(): boolean }>;
	readonly lstat?: (filePath: string) => Promise<{ isSymbolicLink(): boolean }>;
	readonly realpath?: (filePath: string) => Promise<string>;
	readonly openLock?: (filePath: string) => Promise<() => Promise<void>>;
	readonly lockDeadlineMs?: number;
	readonly lockPollMs?: number;
}

const defaultDeps: Deps = {
	mkdir: async (directory) => {
		await fs.mkdir(directory, { recursive: true });
	},
	readdir: (directory) => fs.readdir(directory),
	readFile: (filePath) => fs.readFile(filePath),
	writeFile: async (filePath, data) => {
		await fs.writeFile(filePath, data, "utf8");
	},
	rename: (from, to) => fs.rename(from, to),
	unlink: async (filePath) => {
		await fs.unlink(filePath);
	},
	stat: async (filePath) => {
		const stat = await fs.stat(filePath);
		return { size: stat.size, isFile: () => stat.isFile() };
	},
	lstat: async (filePath) => {
		const stat = await fs.lstat(filePath);
		return { isSymbolicLink: () => stat.isSymbolicLink() };
	},
	realpath: (filePath) => fs.realpath(filePath),
	openLock: async (filePath) => {
		const handle = await fs.open(filePath, "wx");
		return async () => {
			await handle.close();
			try {
				await fs.unlink(filePath);
			} catch (error) {
				if (!isErrno(error, "ENOENT")) throw error;
			}
		};
	},
	lockDeadlineMs: 2000,
	lockPollMs: 10,
};

export interface AgreementRecordSummary {
	readonly kind: AgreementRecord["kind"];
	readonly id: string;
	readonly status: AgreementProposal["status"] | AgreementRevision["status"];
	readonly origin: AgreementRecord["origin"];
}

export interface AgreementActivationResult {
	readonly revisionId: string;
	readonly priorRevisionId: string;
	readonly disposition: "activated" | "unchanged";
}

export interface CrewAgreementStore {
	putProposal(record: unknown): Promise<{ readonly record: AgreementProposal; readonly alreadyPersisted?: boolean }>;
	putRevision(record: unknown): Promise<{ readonly record: AgreementRevision; readonly alreadyPersisted?: boolean }>;
	activateRevision(revisionId: string): Promise<AgreementActivationResult>;
	show(kind: AgreementRecord["kind"], id: string): Promise<AgreementRecord>;
	list(kind?: AgreementRecord["kind"]): Promise<readonly AgreementRecordSummary[]>;
}

export function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
export function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function safeId(id: unknown): id is string {
	return (
		typeof id === "string" &&
		id.trim() === id &&
		id.length > 0 &&
		Buffer.byteLength(id, "utf8") <= MAX_AGREEMENT_RECORD_ID_BYTES &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
	);
}
export function recordError(
	code: CrewAgreementStoreErrorCode,
	message: string,
	cause?: unknown,
): CrewAgreementStoreError {
	return new CrewAgreementStoreError(code, message, cause === undefined ? undefined : { cause });
}
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value)
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export interface ActivationState {
	readonly version: typeof ACTIVATION_STATE_VERSION;
	readonly currentRevisionId: string;
	readonly currentContentHash: string;
}

export interface ActivationJournal extends ActivationState {
	readonly priorRevisionId: string;
	readonly priorContentHash: string;
	readonly nextContent: string;
	readonly nextRevision: AgreementRevision;
}

export function contentHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function parseActivationState(value: unknown): ActivationState {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !["version", "currentRevisionId", "currentContentHash"].includes(key))
	) {
		throw recordError("corrupt-record", "Agreement activation state has an invalid schema");
	}
	const state = value as Record<string, unknown>;
	if (
		state.version !== ACTIVATION_STATE_VERSION ||
		!safeId(state.currentRevisionId) ||
		!isHash(state.currentContentHash)
	)
		throw recordError("corrupt-record", "Agreement activation state has invalid values");
	return {
		version: ACTIVATION_STATE_VERSION,
		currentRevisionId: state.currentRevisionId,
		currentContentHash: state.currentContentHash,
	};
}

export function parseActivationJournal(value: unknown): ActivationJournal {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).some(
			(key) =>
				![
					"version",
					"currentRevisionId",
					"currentContentHash",
					"priorRevisionId",
					"priorContentHash",
					"nextContent",
					"nextRevision",
				].includes(key),
		)
	) {
		throw recordError("corrupt-record", "Agreement activation journal has an invalid schema");
	}
	const journal = value as Record<string, unknown>;
	if (
		journal.version !== ACTIVATION_STATE_VERSION ||
		!safeId(journal.currentRevisionId) ||
		!safeId(journal.priorRevisionId) ||
		!isHash(journal.currentContentHash) ||
		!isHash(journal.priorContentHash) ||
		typeof journal.nextContent !== "string" ||
		Buffer.byteLength(journal.nextContent, "utf8") > MAX_AGREEMENT_TEXT_BYTES ||
		!isAgreementRevision(journal.nextRevision) ||
		journal.nextRevision.status !== "activated" ||
		journal.nextRevision.id !== journal.currentRevisionId
	) {
		throw recordError("corrupt-record", "Agreement activation journal has invalid values");
	}
	return {
		version: ACTIVATION_STATE_VERSION,
		currentRevisionId: journal.currentRevisionId,
		currentContentHash: journal.currentContentHash,
		priorRevisionId: journal.priorRevisionId,
		priorContentHash: journal.priorContentHash,
		nextContent: journal.nextContent,
		nextRevision: journal.nextRevision,
	};
}

export async function readOptionalJson(filePath: string, deps: Deps): Promise<unknown | undefined> {
	try {
		if ((await deps.lstat(filePath)).isSymbolicLink())
			throw recordError("corrupt-record", "Agreement activation metadata must not be a symbolic link");
		const stat = await deps.stat(filePath);
		if (!stat.isFile()) throw recordError("corrupt-record", "Agreement activation metadata is not a regular file");
		if (stat.size > MAX_AGREEMENT_RECORD_FILE_BYTES)
			throw recordError("record-oversized", "Agreement activation metadata is oversized");
		const bytes = await deps.readFile(filePath);
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		if (error instanceof CrewAgreementStoreError) throw error;
		throw recordError("corrupt-record", "Agreement activation metadata is not valid UTF-8 JSON", error);
	}
}

export async function atomicWrite(filePath: string, data: string, deps: Deps): Promise<void> {
	const temporary = `${filePath}${TEMP_PREFIX}${process.pid}-${Date.now()}`;
	try {
		await deps.writeFile(temporary, data);
		await deps.rename(temporary, filePath);
	} catch (error) {
		try {
			await deps.unlink(temporary);
		} catch {
			// Best-effort cleanup. The atomic target was not published.
		}
		throw error;
	}
}

async function withLock<T>(lockPath: string, deps: Deps, operation: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + deps.lockDeadlineMs;
	while (true) {
		try {
			const release = await deps.openLock(lockPath);
			try {
				return await operation();
			} finally {
				await release();
			}
		} catch (error) {
			if (!isErrno(error, "EEXIST") || Date.now() >= deadline)
				throw isErrno(error, "EEXIST")
					? recordError("lock-conflict", "another Agreement record write is in progress", error)
					: error;
			await new Promise((resolve) => setTimeout(resolve, deps.lockPollMs));
		}
	}
}

async function validateStorage(layout: string, deps: Deps): Promise<string> {
	const agreements = path.join(layout, AGREEMENTS_DIR);
	const history = path.join(agreements, HISTORY_DIR);
	await deps.mkdir(history);
	const realLayout = await deps.realpath(layout);
	const realAgreements = await deps.realpath(agreements);
	const realHistory = await deps.realpath(history);
	if (!isInside(realLayout, realAgreements) || !isInside(realAgreements, realHistory))
		throw recordError("path-unsafe", "Agreement history escapes the trusted Crew layout");
	return realHistory;
}

export async function validateRecordDirectory(
	history: string,
	kind: AgreementRecord["kind"],
	deps: Deps,
): Promise<string> {
	const directory = path.join(history, kind === "proposal" ? PROPOSALS_DIR : REVISIONS_DIR);
	await deps.mkdir(directory);
	const realDirectory = await deps.realpath(directory);
	if (!isInside(history, realDirectory))
		throw recordError("path-unsafe", "Agreement record directory escapes trusted history");
	return realDirectory;
}

async function validateRevisionBase(revision: AgreementRevision, history: string, deps: Deps): Promise<void> {
	if (revision.baseRevisionId === "genesis") return;
	const activationState = await readOptionalJson(path.join(history, ACTIVATION_STATE_FILE), deps);
	if (
		activationState !== undefined &&
		parseActivationState(activationState).currentRevisionId === revision.baseRevisionId
	)
		return;
	try {
		const revisionDirectory = await validateRecordDirectory(history, "revision", deps);
		const base = await readRecord(path.join(revisionDirectory, `${revision.baseRevisionId}.json`), deps);
		if (base.kind !== "revision" || base.status !== "activated")
			throw recordError("stale-base", "Agreement revision base is not the current activated revision");
	} catch (error) {
		if (error instanceof CrewAgreementStoreError && error.code === "record-not-found")
			throw recordError("stale-base", `Agreement revision base does not exist: ${revision.baseRevisionId}`);
		throw error;
	}
}

async function persist<T extends AgreementProposal | AgreementRevision>(
	record: T,
	kind: T["kind"],
	history: string,
	deps: Deps,
): Promise<{ readonly record: T; readonly alreadyPersisted?: boolean }> {
	const directory = await validateRecordDirectory(history, kind, deps);
	const target = path.join(directory, `${record.id}.json`);
	try {
		const existing = await readRecord(target, deps);
		if (stableJson(existing) === stableJson(record)) return { record, alreadyPersisted: true };
		throw recordError(
			"idempotency-conflict",
			`Agreement ${kind} id already contains a different record: ${record.id}`,
		);
	} catch (error) {
		if (!(error instanceof CrewAgreementStoreError) || error.code !== "record-not-found") throw error;
	}
	if (kind === "revision") {
		const revision = record as AgreementRevision;
		await validateRevisionReferences(revision, history, deps);
		await validateRevisionBase(revision, history, deps);
	}
	const temporary = path.join(directory, `${TEMP_PREFIX}${record.id}-${process.pid}-${Date.now()}.json`);
	try {
		await deps.writeFile(temporary, stableJson(record));
		await deps.rename(temporary, target);
		return { record };
	} catch (error) {
		try {
			await deps.unlink(temporary);
		} catch {
			// Best-effort cleanup; the target was never published.
		}
		throw recordError("write-failed", `failed to persist Agreement ${kind}`, error);
	}
}

export async function openTrustedCrewAgreementStore(options: {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly deps?: CrewAgreementStoreDependencies;
}): Promise<CrewAgreementStore> {
	if (!options.isProjectTrusted())
		throw recordError("untrusted-project", "cannot open Agreement history in an untrusted project");
	const manifestPath = path.resolve(options.manifestPath);
	if (!isTrustedCrewManifestPath(manifestPath, options.projectRoot))
		throw recordError("untrusted-path", "Agreement history is not trusted project-local configuration");
	const deps: Deps = { ...defaultDeps, ...options.deps };
	const history = await validateStorage(path.dirname(manifestPath), deps);
	const lockPath = path.join(history, LOCK_FILE);
	const put = async <T extends AgreementProposal | AgreementRevision>(record: unknown, kind: T["kind"]) => {
		const valid = kind === "proposal" ? isAgreementProposal(record) : isAgreementRevision(record);
		if (!valid)
			throw recordError(
				kind === "proposal" ? "invalid-proposal" : "invalid-revision",
				`invalid Agreement ${kind}`,
			);
		if (!safeId((record as T).id)) throw recordError("path-unsafe", "Agreement record id is not a safe filename");
		return await withLock(lockPath, deps, () => persist(record as T, kind, history, deps));
	};
	return {
		putProposal: (record) =>
			put(record, "proposal") as Promise<{ record: AgreementProposal; alreadyPersisted?: boolean }>,
		putRevision: (record) =>
			put(record, "revision") as Promise<{ record: AgreementRevision; alreadyPersisted?: boolean }>,
		activateRevision: (revisionId) =>
			withLock(lockPath, deps, () => activate(revisionId, history, manifestPath, deps)),
		show: async (kind, id) => {
			if (kind !== "proposal" && kind !== "revision")
				throw recordError("path-unsafe", "Agreement record kind is not supported");
			if (!safeId(id)) throw recordError("path-unsafe", "Agreement record id is not a safe filename");
			const directory = await validateRecordDirectory(history, kind, deps);
			const record = await readRecord(path.join(directory, `${id}.json`), deps);
			if (record.kind !== kind)
				throw recordError("corrupt-record", "Agreement record kind does not match its history");
			return record;
		},
		list: async (kind) => {
			const kinds = kind === undefined ? (["proposal", "revision"] as const) : ([kind] as const);
			const summaries: AgreementRecordSummary[] = [];
			const activationStateRaw = await readOptionalJson(path.join(history, ACTIVATION_STATE_FILE), deps);
			const activatedRevisionId =
				activationStateRaw === undefined
					? undefined
					: parseActivationState(activationStateRaw).currentRevisionId;
			for (const currentKind of kinds) {
				const directory = await validateRecordDirectory(history, currentKind, deps);
				let names: string[];
				try {
					names = await deps.readdir(directory);
				} catch (error) {
					if (isErrno(error, "ENOENT")) continue;
					throw recordError("read-failed", "failed to list Agreement records", error);
				}
				const files = names.filter((name) => name.endsWith(".json")).sort();
				if (files.length > MAX_AGREEMENT_RECORD_COUNT)
					throw recordError("corrupt-record", "Agreement history exceeds its record bound");
				for (const name of files) {
					const record = await readRecord(path.join(directory, name), deps);
					if (record.kind !== currentKind)
						throw recordError("corrupt-record", "Agreement record kind does not match its history");
					const status =
						record.kind === "revision" && record.id === activatedRevisionId ? "activated" : record.status;
					summaries.push({ kind: record.kind, id: record.id, status, origin: record.origin });
				}
			}
			return summaries.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
		},
	};
}
