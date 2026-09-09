import { promises as fs, constants as fsConstants, type Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { CONTROL_DIR } from "./intray-paths.ts";
import {
	isCrewSessionRecord,
	manifestFingerprintInput,
	type CrewManifest,
	type CrewSessionRecord,
} from "../domain/index.ts";

export const CREW_SESSIONS_DIRNAME = "crew-sessions";
const DIRECTORY_MODE = 0o700;
const RECORD_MODE = 0o600;
const LOCK_FILE = ".capture.lock";
const STAGING_PREFIX = ".record-";

export type CrewSessionStoreErrorCode =
	| "storage-untrusted"
	| "storage-busy"
	| "record-not-found"
	| "record-exists"
	| "invalid-record"
	| "storage-failed";

export class CrewSessionStoreError extends Error {
	readonly code: CrewSessionStoreErrorCode;
	readonly cause?: unknown;

	constructor(code: CrewSessionStoreErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CrewSessionStoreError";
		this.code = code;
		this.cause = cause;
	}
}

export interface CrewSessionStoreOptions {
	readonly rootDir?: string;
	readonly uid?: () => number | undefined;
}

export type CrewSessionStoreEntry =
	| { readonly id: string; readonly record: CrewSessionRecord }
	| { readonly id: string; readonly invalid: true; readonly code: "invalid-record" | "storage-untrusted" };

export interface CrewSessionStore {
	readonly rootDir: string;
	readonly list: () => Promise<readonly CrewSessionRecord[]>;
	readonly listDetailed: () => Promise<readonly CrewSessionStoreEntry[]>;
	readonly read: (id: string) => Promise<CrewSessionRecord>;
	readonly write: (record: CrewSessionRecord, options?: { overwrite?: boolean }) => Promise<void>;
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function validateId(id: string): void {
	if (!/^cs_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/.test(id))
		throw new CrewSessionStoreError("invalid-record", "invalid Crew Session ID");
}

function validatePrivateStat(
	stat: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; uid?: number },
	label: string,
	directory: boolean,
	owner = currentUid(),
): void {
	if (stat.isSymbolicLink()) throw new CrewSessionStoreError("storage-untrusted", `${label} is a symlink`);
	if (directory ? !stat.isDirectory() : !stat.isFile())
		throw new CrewSessionStoreError(
			"storage-untrusted",
			`${label} is not a regular ${directory ? "directory" : "file"}`,
		);
	if ((stat.mode & 0o077) !== 0)
		throw new CrewSessionStoreError("storage-untrusted", `${label} is not private to the current user`);
	if (owner !== undefined && stat.uid !== undefined && stat.uid !== owner)
		throw new CrewSessionStoreError("storage-untrusted", `${label} is not owned by the current user`);
}

async function verifyRoot(rootDir: string, uid: () => number | undefined): Promise<void> {
	try {
		const stat = await fs.lstat(rootDir);
		validatePrivateStat(stat, "Crew Session storage directory", true, uid());
	} catch (error) {
		if (error instanceof CrewSessionStoreError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new CrewSessionStoreError("record-not-found", "Crew Session storage directory does not exist", error);
		throw new CrewSessionStoreError(
			"storage-untrusted",
			"Crew Session storage directory could not be verified",
			error,
		);
	}
}

async function ensureRoot(rootDir: string, uid: () => number | undefined): Promise<void> {
	try {
		const existing = await fs.lstat(rootDir);
		validatePrivateStat(existing, "Crew Session storage directory", true, uid());
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			if (error instanceof CrewSessionStoreError) throw error;
			throw new CrewSessionStoreError(
				"storage-untrusted",
				"Crew Session storage directory could not be verified",
				error,
			);
		}
	}
	try {
		await fs.mkdir(rootDir, { recursive: true, mode: DIRECTORY_MODE });
	} catch (error) {
		throw new CrewSessionStoreError("storage-failed", "Crew Session storage directory could not be created", error);
	}
	await verifyRoot(rootDir, uid);
}

async function validateRecordFile(filePath: string): Promise<void> {
	let stat;
	try {
		stat = await fs.lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new CrewSessionStoreError("record-not-found", "Crew Session record was not found", error);
		throw new CrewSessionStoreError("storage-failed", "Crew Session record could not be inspected", error);
	}
	validatePrivateStat(stat, "Crew Session record", false);
}

async function readRecordFile(filePath: string): Promise<CrewSessionRecord> {
	await validateRecordFile(filePath);
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (error) {
		throw new CrewSessionStoreError("storage-failed", "Crew Session record could not be read", error);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new CrewSessionStoreError("invalid-record", "Crew Session record is not valid JSON", error);
	}
	if (!isCrewSessionRecord(value))
		throw new CrewSessionStoreError("invalid-record", "Crew Session record is invalid");
	return value;
}

async function acquireLock(rootDir: string): Promise<FileHandle> {
	const lockPath = path.join(rootDir, LOCK_FILE);
	try {
		const handle = await fs.open(
			lockPath,
			fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
			RECORD_MODE,
		);
		return handle;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new CrewSessionStoreError("storage-busy", "Crew Session storage is busy", error);
		throw new CrewSessionStoreError("storage-failed", "Crew Session storage lock could not be created", error);
	}
}

async function releaseLock(rootDir: string, handle: FileHandle): Promise<void> {
	try {
		await handle.close();
	} finally {
		await fs.rm(path.join(rootDir, LOCK_FILE), { force: true });
	}
}

function recordPath(rootDir: string, id: string): string {
	validateId(id);
	return path.join(rootDir, `${id}.json`);
}

async function writeAtomic(rootDir: string, record: CrewSessionRecord, overwrite: boolean): Promise<void> {
	const target = recordPath(rootDir, record.id);
	let existing = false;
	try {
		await validateRecordFile(target);
		existing = true;
	} catch (error) {
		if (!(error instanceof CrewSessionStoreError) || error.code !== "record-not-found") throw error;
	}
	if (existing && !overwrite) throw new CrewSessionStoreError("record-exists", "Crew Session record already exists");
	const stagingPath = path.join(rootDir, `${STAGING_PREFIX}${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(
			stagingPath,
			fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
			RECORD_MODE,
		);
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(stagingPath, target);
	} catch (error) {
		if (handle) await handle.close().catch(() => undefined);
		await fs.rm(stagingPath, { force: true }).catch(() => undefined);
		if (error instanceof CrewSessionStoreError) throw error;
		throw new CrewSessionStoreError("storage-failed", "Crew Session record could not be published", error);
	}
}

export function getCrewSessionsDir(controlDir = CONTROL_DIR): string {
	return path.join(controlDir, CREW_SESSIONS_DIRNAME);
}

export function createCrewSessionStore(options: CrewSessionStoreOptions = {}): CrewSessionStore {
	const rootDir = path.resolve(options.rootDir ?? getCrewSessionsDir());
	const uid = options.uid ?? currentUid;
	const listDetailed = async (): Promise<readonly CrewSessionStoreEntry[]> => {
		try {
			await verifyRoot(rootDir, uid);
		} catch (error) {
			if (error instanceof CrewSessionStoreError && error.code === "record-not-found") return [];
			throw error;
		}
		let entries: Dirent[];
		try {
			entries = await fs.readdir(rootDir, { withFileTypes: true });
		} catch (error) {
			throw new CrewSessionStoreError("storage-failed", "Crew Session records could not be listed", error);
		}
		const records: CrewSessionStoreEntry[] = [];
		for (const entry of entries) {
			if (entry.name === LOCK_FILE || entry.name.startsWith(STAGING_PREFIX)) continue;
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const id = entry.name.slice(0, -5);
			try {
				records.push({ id, record: await readRecordFile(recordPath(rootDir, id)) });
			} catch (error) {
				const code =
					error instanceof CrewSessionStoreError && error.code === "storage-untrusted"
						? "storage-untrusted"
						: "invalid-record";
				records.push({ id, invalid: true, code });
			}
		}
		return records.sort((left, right) => left.id.localeCompare(right.id));
	};
	return {
		rootDir,
		listDetailed,
		async list() {
			const entries = await listDetailed();
			const invalid = entries.find(
				(entry): entry is Extract<CrewSessionStoreEntry, { invalid: true }> => "invalid" in entry,
			);
			if (invalid)
				throw new CrewSessionStoreError(invalid.code, `Crew Session record '${invalid.id}' is invalid`);
			return entries.map((entry) => (entry as { record: CrewSessionRecord }).record);
		},
		async read(id) {
			try {
				await verifyRoot(rootDir, uid);
			} catch (error) {
				if (error instanceof CrewSessionStoreError && error.code === "record-not-found")
					throw new CrewSessionStoreError("record-not-found", "Crew Session record was not found", error);
				throw error;
			}
			return readRecordFile(recordPath(rootDir, id));
		},
		async write(record, options = {}) {
			if (!isCrewSessionRecord(record))
				throw new CrewSessionStoreError("invalid-record", "Crew Session record is invalid");
			await ensureRoot(rootDir, uid);
			const lock = await acquireLock(rootDir);
			try {
				await writeAtomic(rootDir, record, options.overwrite === true);
			} finally {
				await releaseLock(rootDir, lock);
			}
		},
	};
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonicalize(item)]),
		);
	}
	return value;
}

export function manifestFingerprint(manifest: CrewManifest): string {
	const canonical = JSON.stringify(canonicalize(manifestFingerprintInput(manifest)));
	return `mfv1-sha256-${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
