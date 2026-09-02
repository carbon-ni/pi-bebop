import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	canonicalMessageLogEntryBytes,
	canonicalMessageLogMarkerBytes,
	validateMessageLogEntry,
	validateMessageLogMarker,
	type MessageLogEntry,
	type MessageLogMarker,
} from "../domain/index.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";
import {
	expireEntries,
	quarantineArtifact,
	RETENTION_AGE_MS,
	readRetentionHighWater,
	persistRetentionHighWater,
	syncRetentionHighWater,
	type HealthyEntry,
} from "./message-log-retention.ts";
import { appendMarkerOperation, readLastCheckpointClose } from "./message-log-marker-store.ts";
import { readMessageLogEntry, validateStoredEntry } from "./message-log-entry-reader.ts";
import { appendEntryLocked } from "./message-log-entry-store.ts";

export type MessageLogStoreErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "id-conflict"
	| "lock-conflict"
	| "invalid-entry"
	| "capacity-exceeded"
	| "write-failed";
export class MessageLogStoreError extends Error {
	constructor(
		readonly code: MessageLogStoreErrorCode,
		message: string,
	) {
		super(message);
		this.name = "MessageLogStoreError";
	}
}

export interface MessageLogStoreOptions {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly fs?: Partial<MessageLogStoreFs>;
	readonly hash?: (value: string) => string;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

type MessageLogStoreFs = {
	mkdir: (directory: string, options: { recursive: true }) => Promise<void>;
	readFile: (filePath: string) => Promise<Buffer>;
	readdir: (directory: string) => Promise<string[]>;
	stat: (filePath: string) => Promise<{ readonly size: number }>;
	writeFile: (
		filePath: string,
		data: string | Uint8Array,
		options?: {
			flag?: string;
		},
	) => Promise<void>;
	link: (existingPath: string, destinationPath: string) => Promise<void>;
	rename: (oldPath: string, newPath: string) => Promise<void>;
	open: (filePath: string, flags: string) => Promise<{ close: () => Promise<void> }>;
	unlink: (filePath: string) => Promise<void>;
	realpath: (filePath: string) => Promise<string>;
	sync: (filePath: string) => Promise<void>;
};

const defaultFs: MessageLogStoreFs = {
	mkdir: async (directory) => {
		await fs.mkdir(directory, { recursive: true });
	},
	readFile: (filePath) => fs.readFile(filePath),
	readdir: (directory) => fs.readdir(directory),
	stat: async (filePath) => {
		const result = await fs.stat(filePath);
		return { size: result.size };
	},
	writeFile: (filePath, data, options) => fs.writeFile(filePath, data, options),
	link: (existingPath, destinationPath) => fs.link(existingPath, destinationPath),
	rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
	open: (filePath, flags) => fs.open(filePath, flags),
	unlink: (filePath) => fs.unlink(filePath),
	realpath: (filePath) => fs.realpath(filePath),
	sync: async (filePath) => {
		const handle = await fs.open(filePath, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
};

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function inside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function makeDependencies(fsOverrides?: Partial<MessageLogStoreFs>): MessageLogStoreFs {
	return {
		mkdir: fsOverrides?.mkdir ?? defaultFs.mkdir,
		readFile: fsOverrides?.readFile ?? defaultFs.readFile,
		readdir: fsOverrides?.readdir ?? defaultFs.readdir,
		stat: fsOverrides?.stat ?? defaultFs.stat,
		writeFile: fsOverrides?.writeFile ?? defaultFs.writeFile,
		link: fsOverrides?.link ?? defaultFs.link,
		rename: fsOverrides?.rename ?? defaultFs.rename,
		open: fsOverrides?.open ?? defaultFs.open,
		unlink: fsOverrides?.unlink ?? defaultFs.unlink,
		realpath: fsOverrides?.realpath ?? defaultFs.realpath,
		sync: fsOverrides?.sync ?? defaultFs.sync,
	};
}

async function checkAccess(
	options: Pick<MessageLogStoreOptions, "manifestPath" | "projectRoot" | "isProjectTrusted">,
	io: MessageLogStoreFs,
): Promise<{ readonly logDir: string; readonly trustedManifestDir: string; readonly trustedLogDir: string }> {
	if (!options.isProjectTrusted())
		throw new MessageLogStoreError("untrusted-project", "message log requires a trusted project");
	const manifestPath = path.resolve(options.manifestPath);
	const projectRoot = path.resolve(options.projectRoot);
	if (!isTrustedCrewManifestPath(manifestPath, projectRoot))
		throw new MessageLogStoreError("untrusted-path", "message log is not in a trusted crew layout");
	let trustedProjectRoot: string;
	let trustedManifestDir: string;
	try {
		trustedProjectRoot = await io.realpath(projectRoot);
		trustedManifestDir = await io.realpath(path.dirname(manifestPath));
	} catch {
		throw new MessageLogStoreError("untrusted-path", "message log is not in a trusted crew layout");
	}
	if (!inside(trustedProjectRoot, trustedManifestDir))
		throw new MessageLogStoreError("untrusted-path", "message log is not in a trusted crew layout");
	const trustedLogDir = path.join(trustedManifestDir, "message-log");
	return {
		logDir: path.join(path.dirname(manifestPath), "message-log"),
		trustedManifestDir,
		trustedLogDir,
	};
}

function asLockError(error: unknown): never {
	if (error instanceof MessageLogStoreError) throw error;
	throw new MessageLogStoreError("write-failed", "message log lock could not be acquired");
}

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_QUARANTINE_FILES = 256;
const MAX_QUARANTINE_BYTES = 16 * 1024 * 1024;
let lockSequence = 0;

function defaultHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function createLockOwner(now: () => number, hash: (value: string) => string): string {
	return hash(`${process.pid}|${now()}|${lockSequence++}`);
}

function ownershipMismatch(path: string): never {
	throw new MessageLogStoreError("lock-conflict", "message log lock ownership changed");
}

async function verifyLockOwner(
	pathToLock: string,
	owner: string,
	io: MessageLogStoreFs,
	handle: { close: () => Promise<void> },
): Promise<void> {
	try {
		const written = (await io.readFile(pathToLock)).toString("utf8");
		if (written !== owner) ownershipMismatch(pathToLock);
	} catch (error) {
		if (!isCode(error, "ENOENT")) {
			if (isCode(error, "EINVAL") || isCode(error, "ENOENT")) ownershipMismatch(pathToLock);
		}
		ownershipMismatch(pathToLock);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function acquireLock(
	lockPath: string,
	io: MessageLogStoreFs,
	deadlineAt: number,
	now: () => number,
	sleep: (milliseconds: number) => Promise<void>,
	hash: (value: string) => string,
): Promise<() => Promise<void>> {
	while (true) {
		let release: null | (() => Promise<void>) = null;
		let owner: string | undefined;
		try {
			const handle = await io.open(lockPath, "wx");
			owner = createLockOwner(now, hash);
			try {
				await io.writeFile(lockPath, owner);
			} catch (error) {
				await handle.close().catch(() => undefined);
				asLockError(error);
			}
			release = async () => {
				await verifyLockOwner(lockPath, owner as string, io, handle);
				await io.unlink(lockPath).catch(() => undefined);
			};
			return release;
		} catch (error) {
			if (error instanceof MessageLogStoreError) throw error;
			if (!isCode(error, "EEXIST")) {
				asLockError(error);
			}
			if (now() >= deadlineAt) throw new MessageLogStoreError("lock-conflict", "message log is busy");
			await sleep(25);
		}
	}
}

function validateLogBoundary(logDir: string, trustedLogDir: string, io: MessageLogStoreFs): Promise<string> {
	return io
		.realpath(logDir)
		.then((resolved) => {
			if (resolved !== trustedLogDir)
				throw new MessageLogStoreError("untrusted-path", "message log is not in a trusted crew layout");
			return resolved;
		})
		.catch((error) => {
			if (isCode(error, "ENOENT")) return logDir;
			if (error instanceof MessageLogStoreError) throw error;
			throw new MessageLogStoreError("write-failed", "message log path could not be resolved");
		});
}

function asWriteError(error: unknown): never {
	if (error instanceof MessageLogStoreError) throw error;
	if (error instanceof Error) throw new MessageLogStoreError("write-failed", error.message);
	throw new MessageLogStoreError("write-failed", "message log publication failed");
}

function isEntryFile(fileName: string): boolean {
	return /^entry-[0-9a-f]{64}\.json$/.test(fileName);
}

type InspectedEntry = HealthyEntry | Uint8Array;

async function readDirectoryOrEmpty(directory: string, io: MessageLogStoreFs): Promise<string[] | undefined> {
	try {
		return await io.readdir(directory);
	} catch (error) {
		if (isCode(error, "ENOENT")) return undefined;
		throw new MessageLogStoreError("write-failed", "message log scan failed");
	}
}

async function measureQuarantine(quarantineDir: string, files: string[], io: MessageLogStoreFs): Promise<number> {
	if (files.length > MAX_QUARANTINE_FILES)
		throw new MessageLogStoreError("capacity-exceeded", "message log quarantine exceeds capacity");
	let total = 0;
	for (const file of files) {
		const size = (await io.stat(path.join(quarantineDir, file))).size;
		if (!Number.isSafeInteger(size) || size < 0 || size > MAX_QUARANTINE_BYTES - total)
			throw new MessageLogStoreError("capacity-exceeded", "message log quarantine exceeds capacity");
		total += size;
	}
	return total;
}

async function readCorruptEntry(
	source: string,
	id: string,
	quarantineBytes: number,
	io: MessageLogStoreFs,
): Promise<InspectedEntry | undefined> {
	let size: number;
	try {
		size = (await io.stat(source)).size;
	} catch (error) {
		if (isCode(error, "ENOENT")) return undefined;
		throw new MessageLogStoreError("write-failed", "message log scan failed");
	}
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_QUARANTINE_BYTES)
		throw new MessageLogStoreError("capacity-exceeded", "message log quarantine exceeds capacity");
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await io.readFile(source));
	} catch {
		throw new MessageLogStoreError("write-failed", "message log scan failed");
	}
	if (bytes.byteLength <= MAX_EVENT_BYTES) {
		try {
			validateStoredEntry(id, bytes);
			const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as MessageLogEntry;
			if (typeof parsed.occurredAt !== "string")
				throw new MessageLogStoreError("invalid-entry", "message log entry is invalid");
			const occurredAt = Date.parse(parsed.occurredAt);
			if (!Number.isSafeInteger(occurredAt) || occurredAt < 0)
				throw new MessageLogStoreError("invalid-entry", "message log entry is invalid");
			return { source, occurredAt };
		} catch (error) {
			if (!(error instanceof MessageLogStoreError) || error.code !== "invalid-entry") throw error;
		}
	}
	if (bytes.byteLength > MAX_QUARANTINE_BYTES - quarantineBytes)
		throw new MessageLogStoreError("capacity-exceeded", "message log quarantine exceeds capacity");
	return bytes;
}

async function validateQuarantineBoundary(
	quarantineDir: string,
	trustedLogDir: string,
	io: MessageLogStoreFs,
): Promise<void> {
	try {
		const resolved = await io.realpath(quarantineDir);
		if (resolved !== path.join(trustedLogDir, "quarantine"))
			throw new MessageLogStoreError("untrusted-path", "message log is not in a trusted crew layout");
	} catch (error) {
		if (isCode(error, "ENOENT")) return;
		if (error instanceof MessageLogStoreError) throw error;
		throw new MessageLogStoreError("write-failed", "message log path could not be resolved");
	}
}

async function quarantineCorruptEntries(
	logDir: string,
	trustedLogDir: string,
	io: MessageLogStoreFs,
	hash: (value: string) => string,
): Promise<readonly HealthyEntry[]> {
	const files = await readDirectoryOrEmpty(logDir, io);
	if (!files) return [];
	const entryFiles = files.filter(isEntryFile);
	if (entryFiles.length > 50_000)
		throw new MessageLogStoreError("capacity-exceeded", "message log scan exceeds capacity");
	const quarantineDir = path.join(logDir, "quarantine");
	await validateQuarantineBoundary(quarantineDir, trustedLogDir, io);
	const quarantinedFiles = (await readDirectoryOrEmpty(quarantineDir, io)) ?? [];
	let quarantineBytes = await measureQuarantine(quarantineDir, quarantinedFiles, io);
	let quarantinedCount = quarantinedFiles.length;
	const healthyEntries: HealthyEntry[] = [];
	for (const file of entryFiles) {
		const inspected = await readCorruptEntry(path.join(logDir, file), file.slice(0, -5), quarantineBytes, io);
		if (!inspected) continue;
		if (!(inspected instanceof Uint8Array)) {
			healthyEntries.push(inspected);
			continue;
		}
		if (quarantinedCount >= MAX_QUARANTINE_FILES)
			throw new MessageLogStoreError("capacity-exceeded", "message log quarantine exceeds capacity");
		await io.mkdir(quarantineDir, { recursive: true });
		await validateQuarantineBoundary(quarantineDir, trustedLogDir, io);
		await quarantineArtifact(path.join(logDir, file), inspected, quarantineDir, io, hash);
		quarantineBytes += inspected.byteLength;
		quarantinedCount += 1;
	}
	return healthyEntries;
}

async function publishEntry(temp: string, target: string, bytes: Uint8Array, io: MessageLogStoreFs): Promise<void> {
	try {
		try {
			await io.sync(temp);
		} catch (error) {
			asWriteError(error);
		}
		try {
			await io.link(temp, target);
		} catch (error) {
			if (isCode(error, "EEXIST")) {
				const existing = await io.readFile(target);
				if (Buffer.compare(existing, Buffer.from(bytes)) !== 0)
					throw new MessageLogStoreError("id-conflict", "message log entry identity conflict");
				return;
			}
			asWriteError(error);
		}
		try {
			await io.sync(target);
			await io.sync(path.dirname(target));
		} catch (error) {
			await io.unlink(target).catch(() => undefined);
			asWriteError(error);
		}
	} finally {
		await io.unlink(temp).catch(() => undefined);
	}
}

export function createMessageLogStore(options: MessageLogStoreOptions) {
	const io = makeDependencies(options.fs);
	const now = options.now ?? (() => Date.now());
	const hash = options.hash ?? defaultHash;
	const sleep =
		options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
	return {
		async append(entry: MessageLogEntry): Promise<void> {
			const { logDir, trustedLogDir } = await checkAccess(options, io);
			try {
				validateMessageLogEntry(entry);
			} catch {
				throw new MessageLogStoreError("invalid-entry", "message log entry is invalid");
			}
			const bytes = canonicalMessageLogEntryBytes(entry);
			if (bytes.byteLength > MAX_EVENT_BYTES)
				throw new MessageLogStoreError("capacity-exceeded", "message log entry exceeds capacity");
			await io.mkdir(logDir, { recursive: true });
			await validateLogBoundary(logDir, trustedLogDir, io);
			const lock = path.join(logDir, ".lock");
			const deadline = now() + 2000;
			const release = await acquireLock(lock, io, deadline, now, sleep, hash);
			try {
				const persistedRetentionNow = await readRetentionHighWater(logDir, trustedLogDir, io);
				const retentionNow = Math.max(now(), persistedRetentionNow);
				await appendEntryLocked(
					entry,
					bytes,
					logDir,
					io,
					retentionNow,
					persistedRetentionNow,
					() => quarantineCorruptEntries(logDir, trustedLogDir, io, hash),
					(entries, cutoff) => expireEntries(entries, cutoff, io),
					(temp, target, value) => publishEntry(temp, target, value, io),
					(value) => persistRetentionHighWater(logDir, trustedLogDir, value, io),
					() => syncRetentionHighWater(logDir, trustedLogDir, io),
				);
			} finally {
				await release();
			}
		},
		async appendMarker(marker: MessageLogMarker): Promise<void> {
			const access = await checkAccess(options, io);
			return appendMarkerOperation(
				marker,
				access,
				io,
				async () => {
					await io.mkdir(access.logDir, { recursive: true });
					await validateLogBoundary(access.logDir, access.trustedLogDir, io);
				},
				async (work) => {
					const release = await acquireLock(
						path.join(access.logDir, ".lock"),
						io,
						now() + 2000,
						now,
						sleep,
						hash,
					);
					try {
						const persisted = await readRetentionHighWater(access.logDir, access.trustedLogDir, io);
						await work(Math.max(now(), persisted), persisted);
					} finally {
						await release();
					}
				},
				(temp, target, value) => publishEntry(temp, target, value, io),
				async (retentionNow, persistedRetentionNow) => {
					if (retentionNow > persistedRetentionNow)
						await persistRetentionHighWater(access.logDir, access.trustedLogDir, retentionNow, io);
					else await syncRetentionHighWater(access.logDir, access.trustedLogDir, io);
				},
			);
		},
		async readLastCheckpointClose(endpointId: string): Promise<{
			readonly checkpoint: MessageLogMarker | null;
			readonly close: MessageLogMarker | null;
		}> {
			if (!/^endpoint-[0-9a-f]{64}$/.test(endpointId))
				throw new MessageLogStoreError("invalid-entry", "message log endpoint is invalid");
			const { logDir, trustedLogDir } = await checkAccess(options, io);
			await validateLogBoundary(logDir, trustedLogDir, io).catch((error) => {
				if (isCode(error, "ENOENT")) return;
				throw error;
			});
			return readLastCheckpointClose(logDir, io, endpointId);
		},
		async read(id: string): Promise<Uint8Array | null> {
			const { logDir, trustedLogDir } = await checkAccess(options, io);
			if (!/^entry-[0-9a-f]{64}$/.test(id))
				throw new MessageLogStoreError("invalid-entry", "message log entry id is invalid");
			await validateLogBoundary(logDir, trustedLogDir, io).catch((error) => {
				if (error instanceof MessageLogStoreError && error.code === "untrusted-path") throw error;
				if (!isCode(error, "ENOENT")) throw error;
			});
			return readMessageLogEntry(id, logDir, io, validateStoredEntry);
		},
	};
}
