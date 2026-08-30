import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { canonicalMessageLogEntryBytes, validateMessageLogEntry, type MessageLogEntry } from "../domain/index.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";

export type MessageLogStoreErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "id-conflict"
	| "lock-conflict"
	| "invalid-entry"
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
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

type MessageLogStoreFs = {
	mkdir: (directory: string, options: { recursive: true }) => Promise<void>;
	readFile: (filePath: string) => Promise<Buffer>;
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
};

const defaultFs: MessageLogStoreFs = {
	mkdir: async (directory) => {
		await fs.mkdir(directory, { recursive: true });
	},
	readFile: (filePath) => fs.readFile(filePath),
	writeFile: (filePath, data, options) => fs.writeFile(filePath, data, options),
	link: (existingPath, destinationPath) => fs.link(existingPath, destinationPath),
	rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
	open: (filePath, flags) => fs.open(filePath, flags),
	unlink: (filePath) => fs.unlink(filePath),
	realpath: (filePath) => fs.realpath(filePath),
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
		writeFile: fsOverrides?.writeFile ?? defaultFs.writeFile,
		link: fsOverrides?.link ?? defaultFs.link,
		rename: fsOverrides?.rename ?? defaultFs.rename,
		open: fsOverrides?.open ?? defaultFs.open,
		unlink: fsOverrides?.unlink ?? defaultFs.unlink,
		realpath: fsOverrides?.realpath ?? defaultFs.realpath,
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

let lockSequence = 0;

function createLockOwner(now: () => number): string {
	return createHash("sha256").update(`${process.pid}|${now()}|${lockSequence++}`).digest("hex");
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
): Promise<() => Promise<void>> {
	while (true) {
		let release: null | (() => Promise<void>) = null;
		let owner: string | undefined;
		try {
			const handle = await io.open(lockPath, "wx");
			owner = createLockOwner(now);
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

export function createMessageLogStore(options: MessageLogStoreOptions) {
	const io = makeDependencies(options.fs);
	const now = options.now ?? (() => Date.now());
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
			await io.mkdir(logDir, { recursive: true });
			await validateLogBoundary(logDir, trustedLogDir, io);
			const fileFor = (id: string) => path.join(logDir, `${id}.json`);
			const lock = path.join(logDir, ".lock");
			const deadline = now() + 2000;
			const release = await acquireLock(lock, io, deadline, now, sleep);
			try {
				if (!/^entry-[0-9a-f]{64}$/.test(String(entry.id)))
					throw new MessageLogStoreError("invalid-entry", "message log entry id is invalid");
				const target = fileFor(String(entry.id));
				try {
					const existing = await io.readFile(target);
					if (Buffer.compare(existing, Buffer.from(bytes)) !== 0)
						throw new MessageLogStoreError("id-conflict", "message log entry identity conflict");
					return;
				} catch (error) {
					if (error instanceof MessageLogStoreError) throw error;
					if (!isCode(error, "ENOENT")) throw error;
				}
				const temp = `${target}.tmp-${process.pid}`;
				await io.writeFile(temp, bytes, { flag: "wx" });
				try {
					await io.link(temp, target);
				} catch (error) {
					if (isCode(error, "EEXIST")) {
						const existing = await io.readFile(target);
						if (Buffer.compare(existing, Buffer.from(bytes)) !== 0)
							throw new MessageLogStoreError("id-conflict", "message log entry identity conflict");
						return;
					}
					if (error instanceof Error) throw new MessageLogStoreError("write-failed", error.message);
					throw new MessageLogStoreError("write-failed", "message log publication failed");
				} finally {
					await io.unlink(temp).catch(() => undefined);
				}
			} finally {
				await release();
			}
		},
		async read(id: string): Promise<Uint8Array | null> {
			const { logDir, trustedLogDir } = await checkAccess(options, io);
			if (!/^entry-[0-9a-f]{64}$/.test(id))
				throw new MessageLogStoreError("invalid-entry", "message log entry id is invalid");
			await validateLogBoundary(logDir, trustedLogDir, io).catch((error) => {
				if (error instanceof MessageLogStoreError && error.code === "untrusted-path") throw error;
				if (!isCode(error, "ENOENT")) throw error;
			});
			const target = path.join(logDir, `${id}.json`);
			try {
				return new Uint8Array(await io.readFile(target));
			} catch (error) {
				if (isCode(error, "ENOENT")) return null;
				throw new MessageLogStoreError("write-failed", "message log read failed");
			}
		},
	};
}
