import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
	CREW_BOARD_VERSION,
	MAX_BOARD_CURSOR_BYTES,
	MAX_BOARD_POSTS,
	canonicalCrewPostBytes,
	compareCrewPostsNewest,
	createBoardPost,
	decodeBoardCursor,
	emptyBoardRead,
	encodeBoardCursor,
	isCrewPost,
	boardScopeForLayout,
	normalizeBoardKinds,
	validateBoardReadLimit,
	type BoardAppendInput,
	type BoardCursor,
	type BoardReadResult,
	type CrewPost,
	type CrewPostKind,
} from "../domain/index.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";

export const CREW_BOARD_DIRNAME = "board";
export const CREW_BOARD_POSTS_DIRNAME = "posts";
export const CREW_BOARD_QUARANTINE_DIRNAME = "quarantine";
export const MAX_BOARD_DIRECTORY_ENTRIES = 8192;
export const MAX_BOARD_POST_FILE_BYTES = 16 * 1024;

export type CrewBoardStoreErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "invalid-member"
	| "invalid-append"
	| "invalid-read"
	| "invalid-cursor"
	| "cursor-filter-mismatch"
	| "capacity-exceeded"
	| "directory-capacity-exceeded"
	| "lock-conflict"
	| "read-failed"
	| "write-failed"
	| "quarantine-failed"
	| "idempotency-conflict"
	| "link-target-invalid";
export class CrewBoardStoreError extends Error {
	constructor(
		readonly code: CrewBoardStoreErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "CrewBoardStoreError";
	}
}
export interface CrewBoardStoreMember {
	readonly name: string;
	readonly role: string;
	readonly socketPath: string;
}
export interface CrewBoardStoreOptions {
	readonly projectRoot: string;
	readonly manifestPath: string;
	readonly isProjectTrusted: () => boolean;
	/** Append-time author snapshot; Membership authorization is application-owned. */
	readonly member: CrewBoardStoreMember;
	readonly members?: readonly CrewBoardStoreMember[];
}
export interface CrewBoardStore {
	append(
		input: BoardAppendInput,
		now: number,
	): Promise<{ readonly version: 1; readonly post: CrewPost; readonly alreadyPersisted: boolean }>;
	read(options?: {
		readonly limit?: number;
		readonly kinds?: readonly CrewPostKind[];
		readonly after?: string;
	}): Promise<BoardReadResult>;
}

type Deps = {
	readonly mkdir: (directory: string) => Promise<void>;
	readonly readdir: (directory: string) => Promise<string[]>;
	readonly readFile: (file: string) => Promise<Buffer>;
	readonly writeFile: (file: string, data: string) => Promise<void>;
	readonly rename: (from: string, to: string) => Promise<void>;
	readonly link: (from: string, to: string) => Promise<void>;
	readonly unlink: (file: string) => Promise<void>;
	readonly stat: (file: string) => Promise<{ size: number; isFile(): boolean }>;
	readonly realpath: (file: string) => Promise<string>;
	readonly openLock: (file: string) => Promise<() => Promise<void>>;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;
};
const deps: Deps = {
	mkdir: async (directory) => {
		await fs.mkdir(directory, { recursive: true });
	},
	readdir: (directory) => fs.readdir(directory),
	readFile: (file) => fs.readFile(file),
	writeFile: async (file, data) => {
		await fs.writeFile(file, data, "utf8");
	},
	rename: (from, to) => fs.rename(from, to),
	link: (from, to) => fs.link(from, to),
	unlink: async (file) => {
		await fs.unlink(file);
	},
	stat: async (file) => {
		const value = await fs.stat(file);
		return { size: value.size, isFile: () => value.isFile() };
	},
	realpath: (file) => fs.realpath(file),
	openLock: async (file) => {
		const handle = await fs.open(file, "wx");
		return async () => {
			await handle.close();
			await fs.unlink(file).catch((error: unknown) => {
				if (!isCode(error, "ENOENT")) throw error;
			});
		};
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
};
function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function inside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function error(code: CrewBoardStoreErrorCode, message: string, cause?: unknown): CrewBoardStoreError {
	return new CrewBoardStoreError(code, message, cause === undefined ? undefined : { cause });
}
function assertOptions(options: CrewBoardStoreOptions): void {
	if (!options.isProjectTrusted()) throw error("untrusted-project", "cannot use Crew Board in an untrusted project");
	const manifest = path.resolve(options.manifestPath);
	if (!isTrustedCrewManifestPath(manifest, options.projectRoot))
		throw error("untrusted-path", "Crew Board requires an active trusted manifest");
	const member = options.member;
	if (
		typeof member.name !== "string" ||
		typeof member.role !== "string" ||
		typeof member.socketPath !== "string" ||
		member.name.trim() !== member.name ||
		member.role.trim() !== member.role ||
		member.socketPath.trim() !== member.socketPath ||
		member.name.length === 0 ||
		member.role.length === 0 ||
		member.socketPath.length === 0 ||
		member.name.includes("\0") ||
		member.role.includes("\0") ||
		member.socketPath.includes("\0")
	)
		throw error("invalid-member", "append-time author snapshot is invalid");
}
let lockSequence = 0;
async function acquire(lock: string): Promise<() => Promise<void>> {
	const deadline = deps.now() + 2000;
	while (true) {
		try {
			const release = await deps.openLock(lock);
			const ownerHash = createHash("sha256")
				.update(`${process.pid}|${deps.now()}|${lockSequence++}`, "utf8")
				.digest("hex");
			try {
				await deps.writeFile(lock, JSON.stringify({ version: 1, ownerHash, createdAt: deps.now() }));
			} catch (cause) {
				await release();
				throw error("write-failed", "failed to initialize Crew Board lock", cause);
			}
			return async () => {
				try {
					const current = JSON.parse((await deps.readFile(lock)).toString("utf8")) as { ownerHash?: string };
					if (current.ownerHash !== ownerHash) throw error("lock-conflict", "Crew Board lock owner changed");
				} catch (cause) {
					if (cause instanceof CrewBoardStoreError) throw cause;
					throw error("lock-conflict", "Crew Board lock ownership cannot be verified", cause);
				}
				await release();
			};
		} catch (cause) {
			if (cause instanceof CrewBoardStoreError) throw cause;
			if (!isCode(cause, "EEXIST")) throw error("lock-conflict", "failed to acquire Crew Board lock", cause);
			if (deps.now() >= deadline) throw error("lock-conflict", "Crew Board lock acquisition timed out", cause);
			await deps.sleep(25);
		}
	}
}
async function readPost(file: string): Promise<CrewPost> {
	const stat = await deps.stat(file);
	if (!stat.isFile() || stat.size > MAX_BOARD_POST_FILE_BYTES) throw new Error("invalid post file");
	const raw = (await deps.readFile(file)).toString("utf8");
	const parsed: unknown = JSON.parse(raw);
	if (!isCrewPost(parsed) || canonicalCrewPostBytes(parsed) !== raw) throw new Error("non-canonical post");
	return parsed;
}
async function quarantine(file: string, quarantineDir: string): Promise<void> {
	await deps.mkdir(quarantineDir);
	const base = `invalid-${requireHash(path.basename(file))}.json`;
	for (let index = 0; index < 100; index += 1) {
		const target = path.join(quarantineDir, index === 0 ? base : `${base.slice(0, -5)}-${index}.json`);
		try {
			await deps.rename(file, target);
			return;
		} catch (cause) {
			if (isCode(cause, "ENOENT")) return;
			if (!isCode(cause, "EEXIST")) throw error("quarantine-failed", "failed to quarantine Crew Post", cause);
		}
	}
	throw error("quarantine-failed", "Crew Post quarantine namespace is full");
}
function requireHash(value: string): string {
	return boardScopeForLayout(value).slice(0, 32);
}
async function scan(
	postsDir: string,
	quarantineDir: string,
	mutate: boolean,
): Promise<{ posts: CrewPost[]; corrupt: number; quarantined: number }> {
	let entries: string[];
	try {
		entries = await deps.readdir(postsDir);
	} catch (cause) {
		if (isCode(cause, "ENOENT")) return { posts: [], corrupt: 0, quarantined: 0 };
		throw error("read-failed", "failed to read Crew Board posts", cause);
	}
	if (entries.length > MAX_BOARD_DIRECTORY_ENTRIES)
		throw error("directory-capacity-exceeded", "Crew Board posts directory exceeds capacity");
	const posts: CrewPost[] = [];
	let corrupt = 0;
	let quarantined = 0;
	const realPostsDir = await deps.realpath(postsDir);
	if (mutate) {
		try {
			await deps.stat(quarantineDir);
			await assertContained(quarantineDir, realPostsDir);
		} catch (cause) {
			if (!isCode(cause, "ENOENT")) throw cause;
		}
	}
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".json") || entry.startsWith(".tmp-")) continue;
		const file = path.join(postsDir, entry);
		try {
			if (!inside(realPostsDir, await deps.realpath(file))) throw new Error("post escapes trusted directory");
			const post = await readPost(file);
			if (path.basename(file, ".json") !== post.id) throw new Error("post filename does not match id");
			posts.push(post);
		} catch (cause) {
			corrupt += 1;
			if (!mutate) continue;
			await quarantine(file, quarantineDir);
			quarantined += 1;
		}
	}
	posts.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
	return { posts, corrupt, quarantined };
}
async function assertContained(directory: string, parent: string): Promise<void> {
	const real = await deps.realpath(directory);
	if (!inside(parent, real)) throw error("untrusted-path", "Crew Board path escapes the trusted layout");
}
async function scanForRead(
	board: string,
	postsDir: string,
	quarantineDir: string,
	lock: string,
	parent: string,
): Promise<{ posts: CrewPost[]; corrupt: number; quarantined: number }> {
	try {
		await deps.stat(board);
		await assertContained(board, parent);
		await deps.stat(postsDir);
		await assertContained(postsDir, parent);
	} catch (cause) {
		if (isCode(cause, "ENOENT")) return { posts: [], corrupt: 0, quarantined: 0 };
		if (cause instanceof CrewBoardStoreError) throw cause;
		throw error("read-failed", "failed to inspect Crew Board posts", cause);
	}
	const release = await acquire(lock);
	try {
		return await scan(postsDir, quarantineDir, true);
	} finally {
		await release();
	}
}
function postIsAfter(post: CrewPost, boundary: Pick<CrewPost, "sequence" | "id">): boolean {
	return post.sequence < boundary.sequence || (post.sequence === boundary.sequence && post.id < boundary.id);
}
function pagePosts(
	ordered: CrewPost[],
	kinds: CrewPostKind[],
	limit: number,
	after: BoardCursor | undefined,
	board: string,
): { posts: CrewPost[]; nextCursor: string | null; hasMore: boolean } {
	const eligible = after ? ordered.filter((post) => postIsAfter(post, after)) : ordered;
	const posts: CrewPost[] = [];
	let boundary: CrewPost | undefined;
	for (const post of eligible) {
		boundary = post;
		if (kinds.length === 0 || kinds.includes(post.kind)) posts.push(post);
		if (posts.length === limit) break;
	}
	const hasMore =
		boundary !== undefined &&
		eligible.some((post) => postIsAfter(post, boundary!) && (kinds.length === 0 || kinds.includes(post.kind)));
	const nextCursor =
		hasMore && boundary ? encodeBoardCursor({ board, sequence: boundary.sequence, id: boundary.id, kinds }) : null;
	return { posts, nextCursor, hasMore };
}
async function appendPost(
	input: BoardAppendInput,
	now: number,
	paths: { readonly postsDir: string; readonly quarantineDir: string; readonly lock: string },
	scope: string,
): Promise<{ readonly version: 1; readonly post: CrewPost; readonly alreadyPersisted: boolean }> {
	if (!Number.isSafeInteger(now) || now < 0) throw error("invalid-append", "append time is invalid");
	await deps.mkdir(paths.postsDir);
	const release = await acquire(paths.lock);
	try {
		const scanned = await scan(paths.postsDir, paths.quarantineDir, true);
		const nextSequence = scanned.posts.length ? Math.max(...scanned.posts.map((post) => post.sequence)) + 1 : 1;
		const candidate = createBoardPost(input, nextSequence, now, scope);
		const target = path.join(paths.postsDir, `${candidate.id}.json`);
		const existing = await existingPost(target, candidate);
		if (existing) return { version: CREW_BOARD_VERSION, post: existing, alreadyPersisted: true };
		if (scanned.posts.length >= MAX_BOARD_POSTS) throw error("capacity-exceeded", "Crew Board is at capacity");
		validateLinkTarget(candidate, scanned.posts);
		const temporary = path.join(paths.postsDir, `.tmp-${candidate.id}`);
		const bytes = canonicalCrewPostBytes(candidate);
		await deps.writeFile(temporary, bytes);
		try {
			await deps.link(temporary, target);
		} catch (cause) {
			return await handlePublishCollision(cause, target, candidate);
		} finally {
			await deps.unlink(temporary).catch(() => undefined);
		}
		return { version: CREW_BOARD_VERSION, post: candidate, alreadyPersisted: false };
	} finally {
		await release();
	}
}
async function existingPost(target: string, candidate: CrewPost): Promise<CrewPost | null> {
	try {
		const existing = await readPost(target);
		if (existing.semanticFingerprint !== candidate.semanticFingerprint)
			throw error("idempotency-conflict", "append operation already has different semantic input");
		return existing;
	} catch (cause) {
		if (isCode(cause, "ENOENT")) return null;
		if (cause instanceof CrewBoardStoreError) throw cause;
		return null;
	}
}
function validateLinkTarget(candidate: CrewPost, posts: readonly CrewPost[]): void {
	if (!candidate.link) return;
	const target = posts.find((post) => post.id === candidate.link?.postId);
	if (
		!target ||
		target.sequence >= candidate.sequence ||
		(candidate.link.relation === "supersedes" && target.author.name !== candidate.author.name) ||
		(candidate.link.relation === "disputes" && target.author.name === candidate.author.name)
	)
		throw error("link-target-invalid", "Crew Post link target is invalid");
}
async function handlePublishCollision(
	cause: unknown,
	target: string,
	candidate: CrewPost,
): Promise<{ readonly version: 1; readonly post: CrewPost; readonly alreadyPersisted: boolean }> {
	if (!isCode(cause, "EEXIST")) throw error("write-failed", "failed to publish Crew Post", cause);
	const existing = await readPost(target);
	if (existing.semanticFingerprint === candidate.semanticFingerprint)
		return { version: CREW_BOARD_VERSION, post: existing, alreadyPersisted: true };
	throw error("idempotency-conflict", "append operation already has different semantic input");
}

export async function openTrustedCrewBoardStore(options: CrewBoardStoreOptions): Promise<CrewBoardStore> {
	assertOptions(options);
	const manifestPath = path.resolve(options.manifestPath);
	const layout = path.dirname(manifestPath);
	const root = path.resolve(options.projectRoot);
	const board = path.join(layout, CREW_BOARD_DIRNAME);
	const postsDir = path.join(board, CREW_BOARD_POSTS_DIRNAME);
	const quarantineDir = path.join(board, CREW_BOARD_QUARANTINE_DIRNAME);
	const lock = path.join(board, ".lock");
	if (!inside(root, board)) throw error("untrusted-path", "Crew Board escapes project root");
	return {
		async append(input, now) {
			const realLayout = await deps.realpath(layout);
			try {
				await deps.stat(board);
				await assertContained(board, realLayout);
			} catch (cause) {
				if (!isCode(cause, "ENOENT")) throw cause;
			}
			await deps.mkdir(postsDir);
			await assertContained(board, realLayout);
			await assertContained(postsDir, realLayout);
			return appendPost(input, now, { postsDir, quarantineDir, lock }, boardScopeForLayout(realLayout));
		},
		async read(readOptions = {}) {
			let limit: number;
			try {
				limit = validateBoardReadLimit(readOptions.limit);
			} catch (cause) {
				throw error("invalid-read", cause instanceof Error ? cause.message : "Crew Board limit is invalid");
			}
			let kinds: CrewPostKind[];
			try {
				kinds = normalizeBoardKinds(readOptions.kinds);
			} catch (cause) {
				throw error("invalid-read", cause instanceof Error ? cause.message : "invalid Crew Board kind filter");
			}
			const realLayout = await deps.realpath(layout);
			const after = readOptions.after
				? decodeBoardCursor(readOptions.after, boardScopeForLayout(realLayout), kinds)
				: undefined;
			const scanned = await scanForRead(board, postsDir, quarantineDir, lock, realLayout);
			if (scanned.posts.length === 0 && scanned.corrupt === 0) return emptyBoardRead();
			const page = pagePosts(
				scanned.posts.sort(compareCrewPostsNewest),
				kinds,
				limit,
				after,
				boardScopeForLayout(realLayout),
			);
			return {
				version: CREW_BOARD_VERSION,
				posts: page.posts,
				nextCursor: page.nextCursor,
				hasMore: page.hasMore,
				corruptCount: Math.min(scanned.corrupt, MAX_BOARD_POSTS),
				quarantinedThisRead: scanned.quarantined,
				corruptCountTruncated: scanned.corrupt > MAX_BOARD_POSTS,
			};
		},
	};
}
