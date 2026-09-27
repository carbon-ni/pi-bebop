import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { isSafeAlias, isSafeSessionId } from "../domain/index.ts";
import { CONTROL_DIR, getAliasPath, getSocketPath } from "../infra/intray-paths.ts";
import { BebopClientError } from "./errors.ts";

const MAX_DISCOVERY_ENTRIES = 256;
const MAX_DISCOVERY_SOURCES = 100;
const MAX_TARGET_BYTES = 256;

export interface BebopOperationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface SourceSelector {
	/** Session id or safe alias. When omitted, the host may provide its own fallback. */
	readonly session?: string;
}

export type SourceState = "joined" | "online" | "unknown";

export interface BebopSourceInfo {
	readonly session: string;
	readonly aliases: readonly string[];
	readonly state: SourceState;
	readonly trusted: boolean;
}

export interface SourceDiscoveryBudget {
	readonly signal: AbortSignal;
	readonly remaining: () => number;
	readonly timedOut?: () => boolean;
}

export interface SourceDiscoveryDependencies<TSource> {
	readonly withBudget: <T>(
		options: BebopOperationOptions | undefined,
		operation: (budget: SourceDiscoveryBudget) => Promise<T>,
	) => Promise<T>;
	readonly querySource: (
		endpoint: string,
		budget: SourceDiscoveryBudget,
	) => Promise<{
		readonly status: { readonly state: SourceState; readonly trusted: boolean };
		readonly endpoint: string;
	}>;
	readonly createSource: (endpoint: string) => TSource;
	readonly normalizeError: (error: unknown, budget: SourceDiscoveryBudget) => BebopClientError;
	readonly environmentSession?: () => string | undefined;
}

export interface SourceDiscoveryOperation<TSource> {
	listSources(options?: BebopOperationOptions): Promise<readonly BebopSourceInfo[]>;
	selectSource(selector?: SourceSelector, options?: BebopOperationOptions): Promise<TSource>;
}

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function retainDiscoveryEntry(entries: Map<string, Dirent>, entry: Dirent): void {
	if (entries.has(entry.name)) return;
	if (entries.size < MAX_DISCOVERY_ENTRIES) {
		entries.set(entry.name, entry);
		return;
	}
	let largest: string | undefined;
	for (const name of entries.keys()) {
		if (largest === undefined || compareNames(name, largest) > 0) largest = name;
	}
	if (largest !== undefined && compareNames(entry.name, largest) < 0) {
		entries.delete(largest);
		entries.set(entry.name, entry);
	}
}

function budgetAbortReason(budget: SourceDiscoveryBudget): unknown {
	return budget.timedOut?.() ? new Error("deadline exceeded") : (budget.signal.reason ?? new Error("aborted"));
}

function awaitBudget<T>(operation: PromiseLike<T>, budget: SourceDiscoveryBudget): Promise<T> {
	const pending = Promise.resolve(operation);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => budget.signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(budgetAbortReason(budget));
		};
		budget.signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
		if (budget.signal.aborted) onAbort();
	});
}

async function closeDirectory(directory: Awaited<ReturnType<typeof fs.opendir>>): Promise<void> {
	try {
		await directory.close();
	} catch {
		// The iterator may already have closed the directory.
	}
}

async function aliasSocket(alias: string, budget: SourceDiscoveryBudget): Promise<string> {
	const aliasPath = getAliasPath(alias);
	const [root, resolved] = await Promise.all([
		awaitBudget(fs.realpath(CONTROL_DIR), budget),
		awaitBudget(fs.realpath(aliasPath), budget),
	]);
	if (budget.signal.aborted) throw budget.signal.reason ?? new Error("aborted");
	const relative = path.relative(root, resolved);
	const base = path.basename(resolved);
	if (
		!relative ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		!base.endsWith(".sock") ||
		!isSafeSessionId(base.slice(0, -5))
	)
		throw new BebopClientError("unknown-session");
	return resolved;
}

async function sourceCandidates(session: string, budget: SourceDiscoveryBudget): Promise<string[]> {
	const candidates: string[] = [];
	if (isSafeSessionId(session)) candidates.push(getSocketPath(session));
	if (isSafeAlias(session)) {
		try {
			candidates.push(await aliasSocket(session, budget));
		} catch (error) {
			if (budget.signal.aborted) throw error;
		}
	}
	return [...new Set(candidates)];
}

function validateSession(value: string): void {
	if (
		value.length === 0 ||
		value !== value.trim() ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > MAX_TARGET_BYTES ||
		(!isSafeSessionId(value) && !isSafeAlias(value))
	)
		throw new BebopClientError("invalid-session");
}

export function createSourceDiscovery<TSource>(
	dependencies: SourceDiscoveryDependencies<TSource>,
): SourceDiscoveryOperation<TSource> {
	async function listSources(options?: BebopOperationOptions): Promise<readonly BebopSourceInfo[]> {
		return dependencies.withBudget(options, async (budget) => {
			const entries = new Map<string, Dirent>();
			let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
			let opening: Promise<Awaited<ReturnType<typeof fs.opendir>>> | undefined;
			try {
				opening = fs.opendir(CONTROL_DIR);
				try {
					directory = await awaitBudget(opening, budget);
				} catch (error) {
					void opening.then(closeDirectory, () => undefined);
					throw error;
				}
				const iterator = directory[Symbol.asyncIterator]();
				for (;;) {
					const result = await awaitBudget(iterator.next(), budget);
					if (result.done) break;
					if (budget.signal.aborted) throw budget.signal.reason ?? new Error("aborted");
					retainDiscoveryEntry(entries, result.value);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			} finally {
				if (directory !== undefined) await closeDirectory(directory);
			}
			const bounded = [...entries.values()].sort((left, right) => compareNames(left.name, right.name));
			const ids = bounded
				.filter((entry) => !entry.isDirectory() && entry.name.endsWith(".sock"))
				.map((entry) => entry.name.slice(0, -5))
				.filter(isSafeSessionId)
				.sort(compareNames)
				.slice(0, MAX_DISCOVERY_SOURCES);
			const aliases = new Map<string, string[]>();
			for (const entry of bounded) {
				if (!entry.isSymbolicLink() || !entry.name.endsWith(".alias")) continue;
				const alias = entry.name.slice(0, -6);
				if (!isSafeAlias(alias)) continue;
				try {
					const endpoint = await aliasSocket(alias, budget);
					const session = path.basename(endpoint).slice(0, -5);
					if (ids.includes(session)) aliases.set(session, [...(aliases.get(session) ?? []), alias]);
				} catch (error) {
					if (budget.signal.aborted) throw error;
				}
			}
			const sources = await Promise.all(
				ids.map(async (session): Promise<BebopSourceInfo> => {
					try {
						const { status } = await dependencies.querySource(getSocketPath(session), budget);
						return {
							session,
							aliases: (aliases.get(session) ?? []).sort(compareNames),
							state: status.state,
							trusted: status.trusted,
						};
					} catch (error) {
						if (budget.signal.aborted) throw error;
						return {
							session,
							aliases: (aliases.get(session) ?? []).sort(compareNames),
							state: "unknown",
							trusted: false,
						};
					}
				}),
			);
			return sources.sort((left, right) => compareNames(left.session, right.session));
		});
	}

	async function selectSource(selector?: SourceSelector, options?: BebopOperationOptions): Promise<TSource> {
		const session = selector?.session ?? dependencies.environmentSession?.();
		if (session === undefined || session === "") throw new BebopClientError("source-required");
		validateSession(session);
		return dependencies.withBudget(options, async (budget) => {
			const candidates = await sourceCandidates(session, budget);
			if (candidates.length === 0) throw new BebopClientError("unknown-session");
			let last: BebopClientError | undefined;
			for (const candidate of candidates) {
				try {
					const selected = await dependencies.querySource(candidate, budget);
					if (selected.status.state !== "joined") throw new BebopClientError("not-joined");
					if (!selected.status.trusted) throw new BebopClientError("untrusted");
					return dependencies.createSource(selected.endpoint);
				} catch (error) {
					const mapped = dependencies.normalizeError(error, budget);
					last = mapped;
					if (mapped.code !== "unknown-session" && mapped.code !== "offline-session") throw mapped;
				}
			}
			throw last ?? new BebopClientError("unknown-session");
		});
	}

	return { listSources, selectSource };
}
