import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
	INBOX_VERSION,
	MAX_INBOX_ITEMS,
	createInboxItemId,
	isInboxItem,
	isInboxTarget,
	isMessagePayload,
	nextInboxSequence,
	type InboxItem,
	type InboxTarget,
} from "../domain/index.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";

/**
 * Trusted durable member-inbox storage (infrastructure boundary).
 *
 * One versioned item per file beneath the active trusted crew layout
 * (`<layout>/inbox/<memberKey>/<itemId>.json`), manifest-adjacent so external-root
 * membership stores next to its manifest. The member key is a hash of the
 * canonical member socket path only: safe from traversal, Unicode collision, and
 * member name/role changes. Transport-only storage: no task, branch, review, Git,
 * or Pi-API knowledge lives here.
 *
 * Durability: enqueue allocates the next sequence under an exclusive per-member
 * lock, writes a temp file, then atomically renames — a crash never publishes
 * partial JSON. Malformed, oversized, or foreign records are quarantined so one
 * bad file cannot block the healthy queue. List/peek return deterministic
 * (sequence, id) order; list summaries carry bounded metadata only.
 */

const INBOX_DIR_NAME = "inbox";
const QUARANTINE_DIR_NAME = "quarantine";
const LOCK_FILE_NAME = ".lock";
const TEMP_PREFIX = ".tmp-";
export const MAX_INBOX_ITEM_FILE_BYTES = 1_100_000;
export const DEFAULT_INBOX_LIST_LIMIT = 32;

export type MemberInboxStoreErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "invalid-member"
	| "invalid-payload"
	| "capacity-exceeded"
	| "lock-conflict"
	| "write-failed"
	| "read-failed"
	| "quarantine-failed"
	| "invalid-item-id"
	| "idempotency-conflict";

export class MemberInboxStoreError extends Error {
	readonly code: MemberInboxStoreErrorCode;

	constructor(code: MemberInboxStoreErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MemberInboxStoreError";
		this.code = code;
	}
}

type Mkdir = (directory: string, options: { recursive: true }) => Promise<string | undefined>;
type ListDir = (directory: string) => Promise<string[]>;
type ReadFile = (filePath: string) => Promise<Buffer>;
type WriteFile = (filePath: string, data: string) => Promise<void>;
type Rename = (oldPath: string, newPath: string) => Promise<void>;
type Unlink = (filePath: string) => Promise<void>;
type Stat = (filePath: string) => Promise<{ size: number; isFile(): boolean; isDirectory(): boolean }>;
type Realpath = (filePath: string) => Promise<string>;
type OpenLock = (lockPath: string) => Promise<() => Promise<void>>;

export interface MemberInboxStoreDependencies {
	mkdir?: Mkdir;
	readdir?: ListDir;
	readFile?: ReadFile;
	writeFile?: WriteFile;
	rename?: Rename;
	unlink?: Unlink;
	stat?: Stat;
	realpath?: Realpath;
	openLock?: OpenLock;
	lockDeadlineMs?: number;
	lockPollMs?: number;
}

const defaultDependencies: Required<MemberInboxStoreDependencies> = {
	mkdir: (directory, options) => fs.mkdir(directory, options),
	readdir: (directory) => fs.readdir(directory),
	readFile: (filePath) => fs.readFile(filePath),
	writeFile: (filePath, data) => fs.writeFile(filePath, data, "utf8"),
	rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
	unlink: (filePath) => fs.unlink(filePath),
	stat: (filePath) => fs.stat(filePath),
	realpath: (filePath) => fs.realpath(filePath),
	openLock: async (lockPath) => {
		const handle = await fs.open(lockPath, "wx");
		return async () => {
			await handle.close();
			try {
				await fs.unlink(lockPath);
			} catch (error) {
				if (!isCode(error, "ENOENT")) throw error;
			}
		};
	},
	lockDeadlineMs: 2000,
	lockPollMs: 25,
};

export interface MemberInboxMember {
	readonly name: string;
	readonly role: string;
	readonly socketPath: string;
}

export interface InboxItemSummary {
	readonly id: string;
	readonly sequence: number;
	readonly enqueuedAt: number;
	readonly bytes: number;
}

export interface MemberInboxStore {
	readonly memberKey: string;
	enqueue(payload: unknown, now: number): Promise<{ readonly item: InboxItem }>;
	/**
	 * Enqueue under a caller-supplied item id (broadcast seam, TASK-0043).
	 *
	 * The id is persisted verbatim (after safe-filename validation) so it can
	 * be a deterministic per-recipient broadcast item id. When an item with
	 * that id already exists the call is an idempotent no-op returning
	 * `{ alreadyPersisted: true }` — the retry path after a partial fan-out.
	 * Throws the same errors as `enqueue` (invalid payload/id, capacity,
	 * storage); `alreadyPersisted` is never an error.
	 */
	enqueueWithId(
		payload: unknown,
		now: number,
		id: string,
	): Promise<{ readonly item: InboxItem } | { readonly alreadyPersisted: true; readonly itemId: string }>;
	peekOldest(): Promise<InboxItem | null>;
	list(limit?: number): Promise<readonly InboxItemSummary[]>;
	count(): Promise<number>;
	remove(id: string): Promise<{ readonly removed: boolean }>;
	cancel(id: string): Promise<{ readonly removed: boolean }>;
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const isInside = (parent: string, child: string): boolean => {
	const relative = path.relative(parent, child);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};

/** Canonical storage key: hash of the member socket path only. */
export function memberInboxStorageKey(socketPath: string): string {
	return `member-${createHash("sha256").update(path.resolve(socketPath)).digest("hex").slice(0, 24)}`;
}

export async function openTrustedMemberInboxStore(options: {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly member: MemberInboxMember;
	readonly deps?: MemberInboxStoreDependencies;
}): Promise<MemberInboxStore> {
	if (!options.isProjectTrusted())
		throw new MemberInboxStoreError("untrusted-project", "cannot open member inbox in an untrusted project");
	const manifestPath = path.resolve(options.manifestPath);
	if (!isTrustedCrewManifestPath(manifestPath, options.projectRoot))
		throw new MemberInboxStoreError(
			"untrusted-path",
			`member inbox storage is not trusted project-local configuration: ${manifestPath}`,
		);

	const member = options.member;
	const socketsRoot = path.join(path.dirname(manifestPath), "sockets");
	const socketPath = path.resolve(member.socketPath);
	if (path.dirname(socketPath) !== socketsRoot)
		throw new MemberInboxStoreError(
			"invalid-member",
			`member socket path must stay under the manifest sockets directory: ${socketPath}`,
		);

	const target: InboxTarget = { name: member.name, socketPath };
	if (!isInboxTarget(target))
		throw new MemberInboxStoreError("invalid-member", "member identity must be a non-empty name and socket path");

	const deps = { ...defaultDependencies, ...options.deps };
	const layoutDir = path.dirname(manifestPath);
	const inboxRoot = path.join(layoutDir, INBOX_DIR_NAME);
	const memberKey = memberInboxStorageKey(socketPath);
	const memberDir = path.join(inboxRoot, memberKey);

	const realLayout = await deps.realpath(layoutDir);
	const realInboxRoot = await ensureContainedDirectory(inboxRoot, realLayout, deps);

	const store: MemberInboxStore = {
		memberKey,
		async enqueue(payload, now) {
			if (!isMessagePayload(payload))
				throw new MemberInboxStoreError("invalid-payload", "inbox payload must be a valid message payload");
			await ensureMemberDir(realInboxRoot, memberDir, deps);
			return await withLock(memberDir, deps, async () => {
				const items = await readItems(memberDir, realInboxRoot, socketPath, deps);
				if (items.length >= MAX_INBOX_ITEMS)
					throw new MemberInboxStoreError(
						"capacity-exceeded",
						`member inbox is full: ${items.length}/${MAX_INBOX_ITEMS} items`,
					);
				const sequence = nextInboxSequence(items);
				const item: InboxItem = {
					version: INBOX_VERSION,
					id: createInboxItemId(target, sequence, payload),
					target,
					payload,
					enqueuedAt: now,
					sequence,
				};
				await persistItem(memberDir, item, deps);
				return { item };
			});
		},

		async enqueueWithId(payload, now, id) {
			if (!isMessagePayload(payload))
				throw new MemberInboxStoreError("invalid-payload", "inbox payload must be a valid message payload");
			assertSafeItemId(id);
			await ensureMemberDir(realInboxRoot, memberDir, deps);
			return await withLock(memberDir, deps, async () => {
				const items = await readItems(memberDir, realInboxRoot, socketPath, deps);
				const existing = items.find((item) => item.id === id);
				if (existing) {
					const sameTarget =
						existing.target.name === target.name && existing.target.socketPath === target.socketPath;
					const samePayload = JSON.stringify(existing.payload) === JSON.stringify(payload);
					if (!sameTarget || !samePayload)
						throw new MemberInboxStoreError(
							"idempotency-conflict",
							`item id already exists with a different target or payload: ${id}`,
						);
					return { alreadyPersisted: true as const, itemId: id };
				}
				if (items.length >= MAX_INBOX_ITEMS)
					throw new MemberInboxStoreError(
						"capacity-exceeded",
						`member inbox is full: ${items.length}/${MAX_INBOX_ITEMS} items`,
					);
				const sequence = nextInboxSequence(items);
				const item: InboxItem = {
					version: INBOX_VERSION,
					id,
					target,
					payload,
					enqueuedAt: now,
					sequence,
				};
				await persistItem(memberDir, item, deps);
				return { item };
			});
		},

		async peekOldest() {
			const items = await readItems(memberDir, realInboxRoot, socketPath, deps);
			return items[0] ?? null;
		},

		async list(limit = DEFAULT_INBOX_LIST_LIMIT) {
			const items = await readItems(memberDir, realInboxRoot, socketPath, deps);
			return items.slice(0, Math.max(0, limit)).map(
				(item): InboxItemSummary => ({
					id: item.id,
					sequence: item.sequence,
					enqueuedAt: item.enqueuedAt,
					bytes: Buffer.byteLength(JSON.stringify(item), "utf8"),
				}),
			);
		},

		async count() {
			return (await readItems(memberDir, realInboxRoot, socketPath, deps)).length;
		},

		async remove(id) {
			return await removeItem(memberDir, realInboxRoot, id, deps);
		},

		async cancel(id) {
			return await removeItem(memberDir, realInboxRoot, id, deps);
		},
	};
	return store;
}

async function ensureContainedDirectory(
	directory: string,
	realParent: string,
	deps: Required<MemberInboxStoreDependencies>,
): Promise<string> {
	await deps.mkdir(directory, { recursive: true });
	const real = await deps.realpath(directory);
	if (!isInside(realParent, real))
		throw new MemberInboxStoreError("untrusted-path", "member inbox directory escapes the trusted crew layout");
	return real;
}

async function ensureMemberDir(
	realInboxRoot: string,
	memberDir: string,
	deps: Required<MemberInboxStoreDependencies>,
): Promise<string> {
	await deps.mkdir(memberDir, { recursive: true });
	const real = await deps.realpath(memberDir);
	if (!isInside(realInboxRoot, real))
		throw new MemberInboxStoreError("untrusted-path", "member inbox directory escapes the trusted inbox root");
	return real;
}

async function withLock<T>(
	memberDir: string,
	deps: Required<MemberInboxStoreDependencies>,
	operation: () => Promise<T>,
): Promise<T> {
	const lockPath = path.join(memberDir, LOCK_FILE_NAME);
	const deadline = Date.now() + deps.lockDeadlineMs;
	let release: (() => Promise<void>) | null = null;
	while (!release) {
		try {
			release = await deps.openLock(lockPath);
		} catch (error) {
			if (!isCode(error, "EEXIST") || Date.now() >= deadline)
				throw new MemberInboxStoreError(
					"lock-conflict",
					`member inbox is locked by another writer: ${memberDir}`,
					{ cause: error },
				);
			await new Promise((resolve) => setTimeout(resolve, deps.lockPollMs));
		}
	}
	try {
		return await operation();
	} finally {
		await release();
	}
}

async function readItems(
	memberDir: string,
	realInboxRoot: string,
	expectedSocketPath: string,
	deps: Required<MemberInboxStoreDependencies>,
): Promise<readonly InboxItem[]> {
	const realMemberDir = await ensureMemberDir(realInboxRoot, memberDir, deps);
	const entries = await deps.readdir(memberDir).catch((error: unknown) => {
		throw new MemberInboxStoreError("read-failed", `failed to read member inbox: ${memberDir}`, { cause: error });
	});
	const items: InboxItem[] = [];
	for (const name of entries.sort()) {
		if (name === QUARANTINE_DIR_NAME || name === LOCK_FILE_NAME || name.startsWith(TEMP_PREFIX)) continue;
		if (!name.endsWith(".json")) continue;
		const filePath = path.join(memberDir, name);
		const record = await readRecord(filePath, realMemberDir, expectedSocketPath, deps);
		if (record) items.push(record);
	}
	items.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
	return items;
}

async function readRecord(
	filePath: string,
	realMemberDir: string,
	expectedSocketPath: string,
	deps: Required<MemberInboxStoreDependencies>,
): Promise<InboxItem | null> {
	try {
		const real = await deps.realpath(filePath);
		if (!isInside(realMemberDir, real)) throw new Error("record resolves outside the member inbox directory");
		const stat = await deps.stat(real);
		if (!stat.isFile()) throw new Error("record is not a regular file");
		if (stat.size > MAX_INBOX_ITEM_FILE_BYTES) throw new Error("record exceeds the size limit");
		const raw = JSON.parse((await deps.readFile(real)).toString("utf8"));
		if (!isInboxItem(raw) || raw.target.socketPath !== expectedSocketPath) throw new Error("record is malformed");
		return raw;
	} catch {
		await quarantine(filePath, deps);
		return null;
	}
}

async function quarantine(filePath: string, deps: Required<MemberInboxStoreDependencies>): Promise<void> {
	try {
		const quarantineDir = path.join(path.dirname(filePath), QUARANTINE_DIR_NAME);
		await deps.mkdir(quarantineDir, { recursive: true });
		const name = path.basename(filePath);
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const target = attempt === 0 ? name : `${name}.${attempt}`;
			const targetPath = path.join(quarantineDir, target);
			try {
				await deps.rename(filePath, targetPath);
				return;
			} catch (error) {
				if (!isCode(error, "ENOENT")) continue;
				return;
			}
		}
		throw new MemberInboxStoreError("quarantine-failed", `failed to quarantine inbox record: ${filePath}`);
	} catch (error) {
		if (error instanceof MemberInboxStoreError) throw error;
		throw new MemberInboxStoreError("quarantine-failed", `failed to quarantine inbox record: ${filePath}`, {
			cause: error,
		});
	}
}

async function silentUnlink(filePath: string, deps: Required<MemberInboxStoreDependencies>): Promise<void> {
	try {
		await deps.unlink(filePath);
	} catch (error) {
		if (!isCode(error, "ENOENT")) throw error;
	}
}

/** Atomic temp-file + rename persistence shared by enqueue paths. */
async function persistItem(
	memberDir: string,
	item: InboxItem,
	deps: Required<MemberInboxStoreDependencies>,
): Promise<void> {
	const finalPath = path.join(memberDir, `${item.id}.json`);
	const tempPath = path.join(memberDir, `${TEMP_PREFIX}${item.id}.json`);
	try {
		await deps.writeFile(tempPath, JSON.stringify(item));
		await deps.rename(tempPath, finalPath);
	} catch (error) {
		await silentUnlink(tempPath, deps);
		throw new MemberInboxStoreError("write-failed", `failed to persist inbox item: ${memberDir}`, {
			cause: error,
		});
	}
}

function assertSafeItemId(id: string): void {
	if (
		typeof id !== "string" ||
		id.length === 0 ||
		id.includes("/") ||
		id.includes("\\") ||
		id.includes("..") ||
		id.includes("\0")
	)
		throw new MemberInboxStoreError("invalid-item-id", "inbox item id must be a safe file name");
}

async function removeItem(
	memberDir: string,
	realInboxRoot: string,
	id: string,
	deps: Required<MemberInboxStoreDependencies>,
): Promise<{ readonly removed: boolean }> {
	assertSafeItemId(id);
	await ensureMemberDir(realInboxRoot, memberDir, deps);
	try {
		await deps.unlink(path.join(memberDir, `${id}.json`));
		return { removed: true };
	} catch (error) {
		if (isCode(error, "ENOENT")) return { removed: false };
		throw new MemberInboxStoreError("write-failed", `failed to remove inbox item: ${memberDir}`, { cause: error });
	}
}
