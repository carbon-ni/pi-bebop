import { promises as fs, watch as watchFilesystem, type Dir, type Dirent } from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MAX_MESSAGE_PAYLOAD_BYTES } from "../domain/message-payload.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";

export const CREW_INTAKE_DIR_NAME = "intake";
export const CREW_INTAKE_NEW_DIR_NAME = "new";
export const CREW_INTAKE_PROCESSED_DIR_NAME = "processed";
export const CREW_INTAKE_FAILED_DIR_NAME = "failed";
export const CREW_INTAKE_RECEIPTS_DIR_NAME = "receipts";
export const CREW_INTAKE_COMMITS_DIR_NAME = "commits";
// Leave room for the external-intake origin and JSON framing before Inbox validation.
export const MAX_CREW_INTAKE_FILE_BYTES = MAX_MESSAGE_PAYLOAD_BYTES - 2_048;
export const MAX_CREW_INTAKE_FILES_PER_SCAN = 32;
export const MAX_CREW_INTAKE_SCAN_BYTES = MAX_CREW_INTAKE_FILE_BYTES * 4;
export const MAX_CREW_INTAKE_SCAN_DURATION_MS = 5_000;
export const MAX_CREW_INTAKE_ENUMERATION_DURATION_MS = 250;
export const MAX_CREW_INTAKE_ENUMERATION_ENTRIES = MAX_CREW_INTAKE_FILES_PER_SCAN * 4;
export const CREW_INTAKE_QUIESCENCE_MS = 25;
const CLAIM_PREFIX = ".processing-";
const LOCK_FILE_NAME = ".scan.lock";
// Claims include a base64url copy of the source name; keep the encoded claim below NAME_MAX.
const MAX_FILENAME_BYTES = 160;
const MAX_FAILURE_REASON_BYTES = 256;
const STALE_LOCK_MS = 10 * 60 * 1000;

export type CrewIntakeDropboxErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "unsafe-directory"
	| "permission-denied"
	| "not-found"
	| "claim-conflict"
	| "changed-while-reading"
	| "invalid-filename"
	| "unsupported-file"
	| "invalid-utf8"
	| "empty-file"
	| "nul-byte"
	| "oversized"
	| "move-conflict"
	| "receipt-conflict"
	| "receipt-failed"
	| "scan-locked"
	| "scan-failed";

export class CrewIntakeDropboxError extends Error {
	readonly code: CrewIntakeDropboxErrorCode;

	constructor(code: CrewIntakeDropboxErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CrewIntakeDropboxError";
		this.code = code;
	}
}

export interface CrewIntakeDropboxOptions {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly quiescenceMs?: number;
}

export interface CrewIntakeDropboxPaths {
	readonly root: string;
	readonly newDir: string;
	readonly processedDir: string;
	readonly failedDir: string;
	readonly receiptsDir: string;
	readonly commitsDir: string;
}

export interface IntakeDropboxWorkItem {
	readonly name: string;
	readonly path: string;
	readonly claimed: boolean;
}

export type IntakeDropboxWorkList = readonly IntakeDropboxWorkItem[] & {
	readonly truncated: boolean;
};

export interface IntakeDropboxClaim {
	readonly name: string;
	readonly path: string;
	readonly claimed: true;
}

export interface IntakeDropboxReceipt {
	readonly version: 1;
	readonly idempotencyKey: string;
	readonly filename: string;
	readonly digest: string;
	readonly itemId: string;
	readonly recordedAt: number;
}

export interface IntakeDropboxCommitIntent {
	readonly version: 1;
	readonly idempotencyKey: string;
	readonly filename: string;
	readonly digest: string;
	readonly target: { readonly name: string; readonly role: string; readonly socketPath: string };
	readonly recordedAt: number;
}

export interface IntakeDropboxContent {
	readonly content: string;
	readonly digest: string;
	readonly bytes: number;
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

async function closeQuietly(handle: { close(): unknown } | undefined): Promise<void> {
	if (!handle) return;
	try {
		await Promise.resolve(handle.close());
	} catch {
		// Cleanup must not hide the operation's original result.
	}
}

function containedPath(directory: string, name: string): string {
	const parent = path.resolve(directory);
	const candidate = path.resolve(parent, name);
	if (candidate !== parent && !candidate.startsWith(`${parent}${path.sep}`))
		throw new CrewIntakeDropboxError("unsafe-directory", "intake path escapes its trusted directory");
	return candidate;
}

interface DirectoryIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly realpath: string;
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
	try {
		const stat = await fs.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new CrewIntakeDropboxError(
				"unsafe-directory",
				`intake directory is not a real directory: ${directory}`,
			);
		return { dev: stat.dev, ino: stat.ino, realpath: await fs.realpath(directory) };
	} catch (error) {
		if (error instanceof CrewIntakeDropboxError) throw error;
		throw new CrewIntakeDropboxError("unsafe-directory", `intake directory is unavailable: ${directory}`, {
			cause: error,
		});
	}
}

function sameDirectoryIdentity(expected: DirectoryIdentity, actual: DirectoryIdentity): boolean {
	const hasStableDeviceIdentity = expected.ino !== 0 && actual.ino !== 0;
	return (
		(!hasStableDeviceIdentity || (expected.dev === actual.dev && expected.ino === actual.ino)) &&
		expected.realpath === actual.realpath
	);
}

export function isSafeCrewIntakeFilename(name: string): boolean {
	return (
		name.length > 0 &&
		name === name.trim() &&
		name !== "." &&
		name !== ".." &&
		path.basename(name) === name &&
		!name.includes("\0") &&
		!/[\u0000-\u001f\u007f-\u009f]/.test(name) &&
		byteLength(name) <= MAX_FILENAME_BYTES
	);
}

function supportedExtension(name: string): boolean {
	const extension = path.extname(name).toLowerCase();
	return extension === ".md" || extension === ".txt";
}

function claimName(name: string): string {
	const digest = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 16);
	return `${CLAIM_PREFIX}${digest}-${Buffer.from(name, "utf8").toString("base64url")}`;
}

function decodeClaimName(name: string): string | null {
	if (!name.startsWith(CLAIM_PREFIX)) return null;
	const separator = name.indexOf("-", CLAIM_PREFIX.length);
	if (separator < 0) return null;
	const encoded = name.slice(separator + 1);
	try {
		const original = Buffer.from(encoded, "base64url").toString("utf8");
		return claimName(original) === name ? original : null;
	} catch {
		return null;
	}
}

function idempotencyKey(manifestPath: string, filename: string, digest: string): string {
	return `intake-${createHash("sha256").update(path.resolve(manifestPath), "utf8").update("\0").update(filename, "utf8").update("\0").update(digest, "utf8").digest("hex")}`;
}

export function createCrewIntakeIdempotencyKey(manifestPath: string, filename: string, digest: string): string {
	return idempotencyKey(manifestPath, filename, digest);
}

async function privateDirectory(directory: string): Promise<void> {
	try {
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const stat = await fs.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new CrewIntakeDropboxError(
				"unsafe-directory",
				`intake directory is not a real directory: ${directory}`,
			);
		if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
			throw new CrewIntakeDropboxError("permission-denied", `intake directory is not private: ${directory}`);
	} catch (error) {
		if (error instanceof CrewIntakeDropboxError) throw error;
		throw new CrewIntakeDropboxError("unsafe-directory", `intake directory is unavailable: ${directory}`, {
			cause: error,
		});
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath);
		return true;
	} catch (error) {
		if (isCode(error, "ENOENT")) return false;
		throw error;
	}
}

async function boundedRead(filePath: string): Promise<Buffer> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(filePath, "r");
		const buffer = Buffer.allocUnsafe(MAX_CREW_INTAKE_FILE_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const result = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		return buffer.subarray(0, offset);
	} catch (error) {
		if (isCode(error, "ENOENT"))
			throw new CrewIntakeDropboxError("not-found", "intake file disappeared", { cause: error });
		throw new CrewIntakeDropboxError("scan-failed", "intake file could not be read", { cause: error });
	} finally {
		await closeQuietly(handle);
	}
}

async function moveNoReplace(source: string, destination: string): Promise<void> {
	if (await exists(destination))
		throw new CrewIntakeDropboxError("move-conflict", `intake destination exists: ${destination}`);
	try {
		await fs.rename(source, destination);
	} catch (error) {
		if (isCode(error, "EEXIST") || isCode(error, "ENOTEMPTY"))
			throw new CrewIntakeDropboxError("move-conflict", `intake destination exists: ${destination}`, {
				cause: error,
			});
		if (isCode(error, "ENOENT"))
			throw new CrewIntakeDropboxError("not-found", "intake claim disappeared", { cause: error });
		throw new CrewIntakeDropboxError("scan-failed", "intake file move failed", { cause: error });
	}
}

export function createCrewIntakeDropbox(options: CrewIntakeDropboxOptions) {
	if (!options.isProjectTrusted())
		throw new CrewIntakeDropboxError("untrusted-project", "cannot use intake in an untrusted project");
	const manifestPath = path.resolve(options.manifestPath);
	if (!isTrustedCrewManifestPath(manifestPath, options.projectRoot))
		throw new CrewIntakeDropboxError("untrusted-path", "intake manifest is outside the trusted project");
	const layoutDir = path.dirname(manifestPath);
	const paths: CrewIntakeDropboxPaths = {
		root: path.join(layoutDir, CREW_INTAKE_DIR_NAME),
		newDir: path.join(layoutDir, CREW_INTAKE_DIR_NAME, CREW_INTAKE_NEW_DIR_NAME),
		processedDir: path.join(layoutDir, CREW_INTAKE_DIR_NAME, CREW_INTAKE_PROCESSED_DIR_NAME),
		failedDir: path.join(layoutDir, CREW_INTAKE_DIR_NAME, CREW_INTAKE_FAILED_DIR_NAME),
		receiptsDir: path.join(layoutDir, CREW_INTAKE_DIR_NAME, CREW_INTAKE_RECEIPTS_DIR_NAME),
		commitsDir: path.join(layoutDir, CREW_INTAKE_DIR_NAME, CREW_INTAKE_COMMITS_DIR_NAME),
	};
	const quiescenceMs = options.quiescenceMs ?? CREW_INTAKE_QUIESCENCE_MS;
	const preparedDirectories = new Map<string, DirectoryIdentity>();
	const privateDirectories = [
		paths.root,
		paths.newDir,
		paths.processedDir,
		paths.failedDir,
		paths.receiptsDir,
		paths.commitsDir,
	] as const;

	const assertPreparedDirectory = async (directory: string): Promise<void> => {
		const expected = preparedDirectories.get(directory);
		if (!expected) throw new CrewIntakeDropboxError("unsafe-directory", "intake directory was not prepared");
		const actual = await directoryIdentity(directory);
		if (!sameDirectoryIdentity(expected, actual))
			throw new CrewIntakeDropboxError("unsafe-directory", "prepared intake directory was replaced");
	};

	const assertPreparedDirectories = async (directories: readonly string[]): Promise<void> => {
		for (const directory of directories) await assertPreparedDirectory(directory);
	};

	const prepare = async (): Promise<void> => {
		try {
			const ancestors = [path.join(path.resolve(options.projectRoot), ".pi"), layoutDir];
			for (const directory of ancestors) {
				const stat = await fs.lstat(directory);
				if (!stat.isDirectory() || stat.isSymbolicLink())
					throw new CrewIntakeDropboxError("unsafe-directory", "crew ancestor is not a real directory");
				if (process.platform !== "win32" && (stat.mode & 0o022) !== 0)
					throw new CrewIntakeDropboxError("permission-denied", "crew ancestor is group/world writable");
			}
			const manifestStat = await fs.lstat(manifestPath);
			if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
				throw new CrewIntakeDropboxError("unsafe-directory", "crew manifest is not a real file");
		} catch (error) {
			if (error instanceof CrewIntakeDropboxError) throw error;
			throw new CrewIntakeDropboxError("unsafe-directory", "crew ancestor is unavailable", { cause: error });
		}

		if (preparedDirectories.size === 0) {
			await privateDirectory(paths.root);
			await Promise.all(privateDirectories.slice(1).map(privateDirectory));
			for (const directory of privateDirectories)
				preparedDirectories.set(directory, await directoryIdentity(directory));
			return;
		}
		await assertPreparedDirectories(privateDirectories);
	};

	const canonicalContainedPath = async (directory: string, name: string): Promise<string> => {
		await assertPreparedDirectory(directory);
		try {
			return containedPath(await fs.realpath(directory), name);
		} catch (error) {
			if (error instanceof CrewIntakeDropboxError) throw error;
			throw new CrewIntakeDropboxError("unsafe-directory", "intake path is not canonically trusted", {
				cause: error,
			});
		}
	};

	const atomicWrite = async (directory: string, filePath: string, content: string): Promise<void> => {
		await assertPreparedDirectory(directory);
		const temp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
		try {
			await assertPreparedDirectory(directory);
			await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await assertPreparedDirectory(directory);
			await fs.rename(temp, filePath);
		} catch (error) {
			try {
				await assertPreparedDirectory(directory);
				await fs.unlink(temp).catch(() => undefined);
			} catch {
				// Do not follow a replaced directory while cleaning up the temporary file.
			}
			throw new CrewIntakeDropboxError("receipt-failed", "intake receipt could not be recorded", {
				cause: error,
			});
		}
	};

	const listDirectory = async (
		directory: string,
	): Promise<{ readonly entries: readonly Dirent[]; readonly truncated: boolean }> => {
		await assertPreparedDirectory(directory);
		const entries: Dirent[] = [];
		let truncated = false;
		let handle: Dir;
		try {
			handle = await fs.opendir(directory);
		} catch (error) {
			throw new CrewIntakeDropboxError("scan-failed", "intake directory could not be listed", { cause: error });
		}
		const deadline = Date.now() + MAX_CREW_INTAKE_ENUMERATION_DURATION_MS;
		try {
			for await (const entry of handle) {
				if (entries.length >= MAX_CREW_INTAKE_ENUMERATION_ENTRIES || Date.now() >= deadline) {
					truncated = true;
					break;
				}
				entries.push(entry);
			}
		} catch (error) {
			throw new CrewIntakeDropboxError("scan-failed", "intake directory could not be listed", { cause: error });
		} finally {
			await closeQuietly(handle);
		}
		return { entries, truncated };
	};

	const listWork = async (): Promise<IntakeDropboxWorkList> => {
		await prepare();
		const listing = await listDirectory(paths.newDir);
		const entries = listing.entries;
		const work: IntakeDropboxWorkItem[] = [];
		for (const entry of entries) {
			if (entry.name.startsWith(CLAIM_PREFIX)) {
				const original = decodeClaimName(entry.name);
				if (original !== null && entry.isFile())
					work.push({ name: original, path: path.join(paths.newDir, entry.name), claimed: true });
				continue;
			}
			if (entry.name.startsWith(".") || !supportedExtension(entry.name) || !entry.isFile()) continue;
			work.push({ name: entry.name, path: path.join(paths.newDir, entry.name), claimed: false });
		}
		const sorted = work.sort((left, right) => left.name.localeCompare(right.name));
		Object.defineProperty(sorted, "truncated", { value: listing.truncated, enumerable: false });
		return sorted as unknown as IntakeDropboxWorkList;
	};

	const claim = async (work: IntakeDropboxWorkItem): Promise<IntakeDropboxClaim | null> => {
		if (work.claimed) {
			return { name: work.name, path: work.path, claimed: true };
		}
		const source = path.join(paths.newDir, work.name);
		const destination = path.join(paths.newDir, claimName(work.name));
		try {
			await assertPreparedDirectory(paths.newDir);
			const stat = await fs.lstat(source);
			if (!stat.isFile() || stat.isSymbolicLink()) return null;
			const before = { size: stat.size, mtimeMs: stat.mtimeMs };
			if (quiescenceMs > 0) await new Promise((resolve) => setTimeout(resolve, quiescenceMs));
			const after = await fs.lstat(source);
			if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
				throw new CrewIntakeDropboxError(
					"changed-while-reading",
					`intake file changed while publishing: ${work.name}`,
				);
			if (await exists(destination))
				throw new CrewIntakeDropboxError("claim-conflict", `intake claim exists: ${work.name}`);
			await assertPreparedDirectory(paths.newDir);
			await fs.rename(source, destination);
			return { name: work.name, path: destination, claimed: true };
		} catch (error) {
			if (error instanceof CrewIntakeDropboxError) throw error;
			if (isCode(error, "ENOENT")) return null;
			throw new CrewIntakeDropboxError("claim-conflict", `intake file could not be claimed: ${work.name}`, {
				cause: error,
			});
		}
	};

	const read = async (item: IntakeDropboxClaim): Promise<IntakeDropboxContent> => {
		await assertPreparedDirectory(paths.newDir);
		let before: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			before = await fs.lstat(item.path);
		} catch (error) {
			throw new CrewIntakeDropboxError("not-found", "intake claim disappeared", { cause: error });
		}
		if (!before.isFile() || before.isSymbolicLink())
			throw new CrewIntakeDropboxError("unsafe-directory", "intake claim is not a regular file");
		await assertPreparedDirectory(paths.newDir);
		const bytes = await boundedRead(item.path);
		await assertPreparedDirectory(paths.newDir);
		const after = await fs.lstat(item.path);
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
			throw new CrewIntakeDropboxError(
				"changed-while-reading",
				`intake file changed while reading: ${item.name}`,
			);
		if (bytes.byteLength > MAX_CREW_INTAKE_FILE_BYTES)
			throw new CrewIntakeDropboxError("oversized", `intake file exceeds ${MAX_CREW_INTAKE_FILE_BYTES} bytes`);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			throw new CrewIntakeDropboxError("invalid-utf8", "intake file is not valid UTF-8", { cause: error });
		}
		if (content.trim().length === 0) throw new CrewIntakeDropboxError("empty-file", "intake file is empty");
		if (content.includes("\0")) throw new CrewIntakeDropboxError("nul-byte", "intake file contains NUL bytes");
		return { content, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
	};

	const durableKeyPath = (directory: string, key: string): string => {
		if (!/^intake-[a-f0-9]{64}$/.test(key))
			throw new CrewIntakeDropboxError("receipt-failed", "intake durability key is invalid");
		return containedPath(directory, `${key}.json`);
	};
	const receiptPath = (key: string): string => durableKeyPath(paths.receiptsDir, key);
	const commitIntentPath = (key: string): string => durableKeyPath(paths.commitsDir, key);
	const readReceipt = async (key: string): Promise<IntakeDropboxReceipt | null> => {
		await assertPreparedDirectory(paths.receiptsDir);
		try {
			const target = receiptPath(key);
			const stat = await fs.lstat(target).catch((error: unknown) => {
				if (isCode(error, "ENOENT")) return null;
				throw error;
			});
			if (stat && (!stat.isFile() || stat.isSymbolicLink()))
				throw new CrewIntakeDropboxError("receipt-failed", "intake receipt is not a regular file");
			if (!stat) return null;
			const raw = await fs.readFile(target, "utf8");
			const parsed = JSON.parse(raw) as IntakeDropboxReceipt;
			if (
				parsed.version !== 1 ||
				parsed.idempotencyKey !== key ||
				typeof parsed.filename !== "string" ||
				typeof parsed.digest !== "string" ||
				typeof parsed.itemId !== "string"
			)
				throw new Error("invalid receipt");
			return parsed;
		} catch (error) {
			if (isCode(error, "ENOENT")) return null;
			if (error instanceof CrewIntakeDropboxError) throw error;
			throw new CrewIntakeDropboxError("receipt-failed", "intake receipt is invalid or unreadable", {
				cause: error,
			});
		}
	};
	const writeReceipt = async (receipt: IntakeDropboxReceipt): Promise<void> => {
		const existing = await readReceipt(receipt.idempotencyKey);
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(receipt))
				throw new CrewIntakeDropboxError(
					"receipt-conflict",
					"intake receipt conflicts with existing durability evidence",
				);
			return;
		}
		await atomicWrite(paths.receiptsDir, receiptPath(receipt.idempotencyKey), JSON.stringify(receipt));
	};
	const readCommitIntent = async (key: string): Promise<IntakeDropboxCommitIntent | null> => {
		await assertPreparedDirectory(paths.commitsDir);
		try {
			const target = commitIntentPath(key);
			const stat = await fs.lstat(target).catch((error: unknown) => {
				if (isCode(error, "ENOENT")) return null;
				throw error;
			});
			if (stat && (!stat.isFile() || stat.isSymbolicLink()))
				throw new CrewIntakeDropboxError("receipt-failed", "intake commit intent is not a regular file");
			if (!stat) return null;
			const raw = await fs.readFile(target, "utf8");
			const parsed = JSON.parse(raw) as IntakeDropboxCommitIntent;
			if (
				parsed.version !== 1 ||
				parsed.idempotencyKey !== key ||
				typeof parsed.filename !== "string" ||
				typeof parsed.digest !== "string" ||
				!parsed.target ||
				typeof parsed.target.name !== "string" ||
				typeof parsed.target.role !== "string" ||
				typeof parsed.target.socketPath !== "string"
			)
				throw new Error("invalid commit intent");
			return parsed;
		} catch (error) {
			if (isCode(error, "ENOENT")) return null;
			throw new CrewIntakeDropboxError("receipt-failed", "intake commit intent is invalid or unreadable", {
				cause: error,
			});
		}
	};
	const writeCommitIntent = async (intent: IntakeDropboxCommitIntent): Promise<void> => {
		const existing = await readCommitIntent(intent.idempotencyKey);
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(intent))
				throw new CrewIntakeDropboxError(
					"receipt-conflict",
					"intake commit intent conflicts with existing durability evidence",
				);
			return;
		}
		await atomicWrite(paths.commitsDir, commitIntentPath(intent.idempotencyKey), JSON.stringify(intent));
	};

	const acquirePublicationLock = async (): Promise<() => Promise<void>> => {
		const lockPath = path.join(paths.root, LOCK_FILE_NAME);
		for (let attempt = 0; attempt < 400; attempt += 1) {
			try {
				const handle = await fs.open(lockPath, "wx", 0o600);
				try {
					await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
					await handle.sync();
				} catch (error) {
					await closeQuietly(handle);
					await fs.unlink(lockPath).catch(() => undefined);
					throw error;
				}
				let released = false;
				return async () => {
					if (released) return;
					released = true;
					await closeQuietly(handle);
					await fs.unlink(lockPath).catch(() => undefined);
				};
			} catch (error) {
				if (!isCode(error, "EEXIST"))
					throw new CrewIntakeDropboxError("scan-locked", "intake publication lock could not be acquired", {
						cause: error,
					});
				let stale = false;
				try {
					const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown };
					if (typeof owner.pid !== "number" || owner.pid <= 0 || owner.pid === process.pid)
						throw new Error("active owner");
					try {
						process.kill(owner.pid, 0);
						throw new Error("active owner");
					} catch (probeError) {
						if (probeError instanceof Error && probeError.message === "active owner") throw probeError;
						if (isCode(probeError, "EPERM")) throw new Error("active owner");
						if (isCode(probeError, "ESRCH")) stale = true;
						else throw probeError;
					}
				} catch (ownerError) {
					if (ownerError instanceof Error && ownerError.message === "active owner") stale = false;
					else {
						const stat = await fs.stat(lockPath);
						stale = Date.now() - stat.mtimeMs > STALE_LOCK_MS;
					}
				}
				if (stale) {
					await fs.unlink(lockPath).catch(() => undefined);
					continue;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		throw new CrewIntakeDropboxError("scan-locked", "intake publication is busy; retry shortly");
	};

	const publish = async (
		name: string,
		content: string,
	): Promise<{
		readonly state: "published" | "already-published";
		readonly bytes: number;
		readonly digest: string;
	}> => {
		if (!isSafeCrewIntakeFilename(name))
			throw new CrewIntakeDropboxError("invalid-filename", "intake filename is unsafe");
		if (!supportedExtension(name))
			throw new CrewIntakeDropboxError("unsupported-file", "intake filename must end in .md or .txt");
		const bytes = Buffer.from(content, "utf8");
		if (bytes.byteLength === 0 || content.trim().length === 0)
			throw new CrewIntakeDropboxError("empty-file", "intake message is empty");
		if (content.includes("\0")) throw new CrewIntakeDropboxError("nul-byte", "intake message contains NUL bytes");
		if (bytes.byteLength > MAX_CREW_INTAKE_FILE_BYTES)
			throw new CrewIntakeDropboxError("oversized", `intake message exceeds ${MAX_CREW_INTAKE_FILE_BYTES} bytes`);
		await prepare();
		const releasePublicationLock = await acquirePublicationLock();
		try {
			const digest = createHash("sha256").update(bytes).digest("hex");
			const destination = await canonicalContainedPath(paths.newDir, name);
			const claimed = await canonicalContainedPath(paths.newDir, claimName(name));
			const processed = await canonicalContainedPath(paths.processedDir, name);
			const matches = async (candidate: string): Promise<boolean> => {
				try {
					const stat = await fs.lstat(candidate);
					if (!stat.isFile() || stat.isSymbolicLink())
						throw new CrewIntakeDropboxError(
							"unsafe-directory",
							"intake publication destination is not a file",
						);
					const existing = await fs.readFile(candidate);
					return createHash("sha256").update(existing).digest("hex") === digest;
				} catch (error) {
					if (isCode(error, "ENOENT")) return false;
					throw error;
				}
			};
			if ((await matches(destination)) || (await matches(processed)) || (await matches(claimed)))
				return { state: "already-published", bytes: bytes.byteLength, digest };
			if ((await exists(destination)) || (await exists(claimed)))
				throw new CrewIntakeDropboxError("move-conflict", `intake destination exists: ${name}`);
			// Stage outside `new` so scanners can never observe a partial publication.
			const temporary = path.join(paths.root, `.draft-${randomUUID()}`);
			let handle: fs.FileHandle | undefined;
			try {
				await assertPreparedDirectory(paths.root);
				handle = await fs.open(temporary, "wx", 0o600);
				let offset = 0;
				while (offset < bytes.byteLength) {
					const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
					if (result.bytesWritten <= 0)
						throw new CrewIntakeDropboxError("scan-failed", "intake message write made no progress");
					offset += result.bytesWritten;
				}
				await handle.sync();
				await handle.close();
				handle = undefined;
				await assertPreparedDirectory(paths.newDir);
				// A hard link publishes the fully fsynced file atomically without replacing
				// a destination that appeared after the initial collision check.
				try {
					await fs.link(temporary, destination);
				} catch (error) {
					if (isCode(error, "EEXIST")) {
						if (await matches(destination))
							return { state: "already-published", bytes: bytes.byteLength, digest };
						throw new CrewIntakeDropboxError("move-conflict", `intake destination exists: ${name}`, {
							cause: error,
						});
					}
					throw new CrewIntakeDropboxError("scan-failed", "intake message could not be published", {
						cause: error,
					});
				}
				return { state: "published", bytes: bytes.byteLength, digest };
			} finally {
				await closeQuietly(handle);
				await fs.unlink(temporary).catch(() => undefined);
			}
		} finally {
			await releasePublicationLock();
		}
	};

	const moveTo = async (item: IntakeDropboxClaim, directory: string): Promise<void> => {
		if (!isSafeCrewIntakeFilename(item.name))
			throw new CrewIntakeDropboxError("invalid-filename", "decoded intake claim name is unsafe");
		await assertPreparedDirectories([paths.newDir, directory]);
		const source = await canonicalContainedPath(paths.newDir, path.basename(item.path));
		const destination = await canonicalContainedPath(directory, item.name);
		await assertPreparedDirectories([paths.newDir, directory]);
		await moveNoReplace(source, destination);
	};
	const moveProcessed = (item: IntakeDropboxClaim): Promise<void> => moveTo(item, paths.processedDir);
	const moveFailed = async (item: IntakeDropboxClaim, reason: string): Promise<void> => {
		const boundedReason = reason.slice(0, MAX_FAILURE_REASON_BYTES);
		const safeName = isSafeCrewIntakeFilename(item.name);
		const physicalName = path.basename(item.path);
		const destinationName = safeName ? item.name : physicalName;
		await assertPreparedDirectories([paths.newDir, paths.failedDir]);
		const destination = await canonicalContainedPath(paths.failedDir, destinationName);
		const reasonName = safeName
			? `${item.name}.reason.json`
			: `${createHash("sha256").update(physicalName, "utf8").digest("hex")}.reason.json`;
		const reasonPath = await canonicalContainedPath(paths.failedDir, reasonName);
		if (!(await exists(reasonPath))) {
			await assertPreparedDirectory(paths.failedDir);
			await atomicWrite(
				paths.failedDir,
				reasonPath,
				JSON.stringify({ version: 1, filename: item.name, reason: boundedReason, recordedAt: Date.now() }),
			);
		}
		await assertPreparedDirectories([paths.newDir, paths.failedDir]);
		await moveNoReplace(await canonicalContainedPath(paths.newDir, physicalName), destination);
	};
	const release = async (item: IntakeDropboxClaim): Promise<void> => {
		if (!isSafeCrewIntakeFilename(item.name)) return;
		await assertPreparedDirectory(paths.newDir);
		const source = await canonicalContainedPath(paths.newDir, path.basename(item.path));
		const destination = await canonicalContainedPath(paths.newDir, item.name);
		if (await exists(destination))
			throw new CrewIntakeDropboxError("move-conflict", `intake source exists: ${item.name}`);
		await assertPreparedDirectory(paths.newDir);
		await fs.rename(source, destination);
	};

	const lock = async (): Promise<() => Promise<void>> => {
		await prepare();
		await assertPreparedDirectory(paths.root);
		const lockPath = path.join(paths.root, LOCK_FILE_NAME);
		const acquire = async () => {
			await assertPreparedDirectory(paths.root);
			const handle = await fs.open(lockPath, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
				return handle;
			} catch (error) {
				await closeQuietly(handle);
				await fs.unlink(lockPath).catch(() => undefined);
				throw error;
			}
		};
		try {
			const handle = await acquire();
			return async () => {
				await handle.close();
				await assertPreparedDirectory(paths.root);
				await fs.unlink(lockPath).catch(() => undefined);
			};
		} catch (error) {
			if (!isCode(error, "EEXIST"))
				throw new CrewIntakeDropboxError("scan-locked", "intake scan lock could not be acquired", {
					cause: error,
				});
			try {
				let stale = false;
				try {
					const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown };
					if (typeof owner.pid !== "number" || owner.pid <= 0 || owner.pid === process.pid)
						throw new Error("active owner");
					try {
						process.kill(owner.pid, 0);
						throw new Error("active owner");
					} catch (probeError) {
						if (isCode(probeError, "EPERM")) throw new Error("active owner");
						if (isCode(probeError, "ESRCH")) stale = true;
						else throw probeError;
					}
				} catch (ownerError) {
					if (ownerError instanceof Error && ownerError.message === "active owner") throw ownerError;
					const stat = await fs.stat(lockPath);
					stale = Date.now() - stat.mtimeMs > STALE_LOCK_MS;
				}
				if (!stale) throw new Error("active owner");
				await fs.unlink(lockPath);
				const handle = await acquire();
				return async () => {
					await handle.close();
					await assertPreparedDirectory(paths.root);
					await fs.unlink(lockPath).catch(() => undefined);
				};
			} catch (recoveryError) {
				throw new CrewIntakeDropboxError("scan-locked", "another intake scan is active", {
					cause: recoveryError,
				});
			}
		}
	};

	const watch = (onEvent: () => void, onError: (error: unknown) => void): { close(): void } => {
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		const schedule = (): void => {
			if (closed) return;
			if (retryTimer !== undefined) clearTimeout(retryTimer);
			retryTimer = setTimeout(
				() => {
					retryTimer = undefined;
					if (!closed) onEvent();
				},
				Math.max(0, quiescenceMs),
			);
		};
		const watcher = watchFilesystem(paths.newDir, schedule);
		watcher.on("error", (error) => {
			if (retryTimer !== undefined) clearTimeout(retryTimer);
			retryTimer = undefined;
			onError(error);
		});
		return {
			close: () => {
				closed = true;
				if (retryTimer !== undefined) clearTimeout(retryTimer);
				retryTimer = undefined;
				watcher.close();
			},
		};
	};

	return {
		manifestPath,
		paths,
		prepare,
		listWork,
		claim,
		read,
		publish,
		readReceipt,
		writeReceipt,
		moveProcessed,
		moveFailed,
		readCommitIntent,
		writeCommitIntent,
		release,
		lock,
		watch,
	};
}

export type CrewIntakeDropbox = ReturnType<typeof createCrewIntakeDropbox>;
