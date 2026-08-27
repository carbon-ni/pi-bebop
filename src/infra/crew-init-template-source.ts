/**
 * Template source adapters for `crew init --from` (infra, injected deps).
 *
 * - Local: reads a directory tree with Dirent-only traversal (symlinks are
 *   recorded, never followed; `.git` directories are skipped entirely).
 * - Git: plain `git` CLI behind an injected runner; clone -> optional
 *   detached checkout of `--ref` -> `rev-parse HEAD` -> local read; the
 *   clone directory is always removed. No prompts, no config, no env.
 *
 * Bounds keep template reading deterministic and cheap: depth, file count,
 * and byte ceilings with a stable overflow code.
 */

import path from "node:path";
import { promises as nodeFs } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
	classifyTemplateSource,
	describeTemplateSource,
	type TemplateEntries,
	type TemplateSourceDescriptor,
} from "../domain/index.ts";

export const TEMPLATE_MAX_DEPTH = 3;
export const TEMPLATE_MAX_FILES = 64;
export const TEMPLATE_MAX_TOTAL_BYTES = 256 * 1024;
export const TEMPLATE_MAX_FILE_BYTES = 64 * 1024;

export interface TemplateDirEntry {
	readonly name: string;
	readonly isFile: () => boolean;
	readonly isDirectory: () => boolean;
	readonly isSymbolicLink: () => boolean;
}

/** Injected read-only filesystem surface for template trees. */
export interface LocalTemplateFs {
	readonly readdir: (dir: string) => Promise<readonly TemplateDirEntry[]>;
	readonly readFile: (file: string) => Promise<string>;
}

export type TemplateSourceRead =
	| { readonly ok: true; readonly entries: TemplateEntries; readonly descriptor: TemplateSourceDescriptor }
	| { readonly ok: false; readonly code: string; readonly message: string };

export interface TemplateSourceAdapter {
	readonly read: (
		descriptor: TemplateSourceDescriptor,
		opts: { readonly cwd: string },
	) => Promise<TemplateSourceRead>;
}

function tooLarge(limit: string): { ok: false; code: string; message: string } {
	return {
		ok: false,
		code: "template-source-too-large",
		message: `Template source exceeds the ${limit} limit; reduce the template and rerun`,
	};
}

/** Deterministic breadth-limited walk; directories recorded with a trailing `/`. */
export async function readTemplateEntries(rootAbs: string, fs: LocalTemplateFs): Promise<TemplateSourceRead> {
	const entries: TemplateEntries = {};
	let files = 0;
	let totalBytes = 0;

	const walk = async (dirAbs: string, prefix: string, depth: number): Promise<TemplateSourceRead | undefined> => {
		const children = [...(await fs.readdir(dirAbs))].sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			if (child.isDirectory()) {
				if (child.name === ".git") continue;
				const relative = `${prefix}${child.name}/`;
				if (depth + 1 > TEMPLATE_MAX_DEPTH) return tooLarge(`depth ${TEMPLATE_MAX_DEPTH}`);
				entries[relative] = { kind: "directory" };
				const inner = await walk(`${dirAbs}/${child.name}`, relative, depth + 1);
				if (inner) return inner;
				continue;
			}
			const relative = `${prefix}${child.name}`;
			if (child.isSymbolicLink()) {
				entries[relative] = { kind: "symlink" };
				continue;
			}
			if (!child.isFile()) continue;
			files += 1;
			if (files > TEMPLATE_MAX_FILES) return tooLarge(`${TEMPLATE_MAX_FILES} files`);
			const bytes = await fs.readFile(`${dirAbs}/${child.name}`);
			const byteLength = Buffer.byteLength(bytes, "utf8");
			if (byteLength > TEMPLATE_MAX_FILE_BYTES) return tooLarge(`${TEMPLATE_MAX_FILE_BYTES} bytes per file`);
			totalBytes += byteLength;
			if (totalBytes > TEMPLATE_MAX_TOTAL_BYTES) return tooLarge(`${TEMPLATE_MAX_TOTAL_BYTES} total bytes`);
			entries[relative] = { kind: "file", bytes };
		}
		return undefined;
	};

	const failure = await walk(rootAbs, "", 0);
	if (failure) return failure;
	return { ok: true, entries, descriptor: { kind: "local", location: rootAbs } };
}

function errnoCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code: unknown }).code)
		: "";
}

/** Local filesystem adapter: resolves the location against cwd and reads the tree. */
export function createLocalTemplateSourceAdapter(fs: LocalTemplateFs): TemplateSourceAdapter {
	return {
		async read(descriptor, opts) {
			if (descriptor.kind !== "local") throw new Error("local adapter requires a local descriptor");
			const rootAbs = path.resolve(opts.cwd, descriptor.location);
			try {
				const result = await readTemplateEntries(rootAbs, fs);
				// Keep provenance caller-relative: the resolved absolute path is an IO
				// detail and must never leak into CLI output.
				if (!result.ok) return result;
				const location = path.relative(opts.cwd, rootAbs).split(path.sep).join("/") || ".";
				return { ...result, descriptor: { kind: "local", location } };
			} catch (error) {
				const code = errnoCode(error);
				if (code === "ENOENT") {
					return {
						ok: false,
						code: "template-source-unreadable",
						message: `Template source not found: ${descriptor.location}`,
					};
				}
				return {
					ok: false,
					code: "template-source-unreadable",
					message: `Template source is not readable: ${descriptor.location}`,
				};
			}
		},
	};
}

/**
 * Resolves the final source kind for a raw `--from` value. Explicit relative
 * and absolute paths are always local; URL/scp shapes are always git. The one
 * ambiguous shape (relative `x/y.git`) prefers local only when it exists as a
 * real directory; there is never a fallback from a failed git source to a
 * local relative path or vice versa.
 */
export async function resolveTemplateSourceDescriptor(
	raw: string,
	cwd: string,
	statDir: (abs: string) => Promise<boolean>,
): Promise<TemplateSourceDescriptor> {
	const syntactic = classifyTemplateSource(raw);
	if (syntactic.kind === "local") return syntactic;
	const relativeGitLike =
		raw.toLowerCase().endsWith(".git") &&
		raw.includes("/") &&
		!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) &&
		!raw.startsWith("git@") &&
		!raw.startsWith("./") &&
		!raw.startsWith("../") &&
		!raw.startsWith("/");
	if (!relativeGitLike) return syntactic;
	const existsAsDirectory = await statDir(path.resolve(cwd, raw));
	return existsAsDirectory ? { kind: "local", location: raw } : syntactic;
}

/** Production resolver; stat failures are treated as a non-existent directory. */
export async function resolveNodeTemplateSourceDescriptor(raw: string, cwd: string): Promise<TemplateSourceDescriptor> {
	return resolveTemplateSourceDescriptor(raw, cwd, async (absolute) => {
		try {
			return (await nodeFs.stat(absolute)).isDirectory();
		} catch {
			return false;
		}
	});
}

// ============================================================================
// Git adapter
// ============================================================================

export interface GitRunnerResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs `git <args>`; rejects (ENOENT) when git itself is unavailable. */
export type GitRunner = (args: readonly string[]) => Promise<GitRunnerResult>;

export interface GitSourceDeps {
	readonly runner: GitRunner;
	readonly mkdtemp: () => Promise<string>;
	readonly rm: (dir: string) => Promise<void>;
	readonly fs: LocalTemplateFs;
}

function gitFailure(code: string, message: string): { ok: false; code: string; message: string } {
	return { ok: false, code, message };
}

function safeGitLocation(location: string): string {
	return describeTemplateSource({ kind: "git", location }).location;
}

function classifyCloneFailure(location: string, output: string): { ok: false; code: string; message: string } {
	const text = output.toLowerCase();
	if (/could not resolve host|network|connection|timed out|timeout|unreachable/.test(text)) {
		return gitFailure("git-network-unreachable", `Template source is unreachable: ${location}`);
	}
	if (
		/authentication|authorization|permission denied|403|could not read username|private|not authorized/.test(text)
	) {
		return gitFailure(
			"git-auth-required",
			`Template source requires authentication or is private; this is not supported; use a public source or a local copy`,
		);
	}
	if (/not supported|unknown scheme|invalid url|bad url|protocol/.test(text)) {
		return gitFailure("git-unsupported-url", `Template source URL or transport is not supported: ${location}`);
	}
	return gitFailure("git-clone-failed", `Failed to clone template source: ${location}`);
}

const COMMIT_HASH = /^[0-9a-f]{40,64}$/;

/** Git adapter: clone (+ optional detached ref checkout) -> rev-parse -> tree read; always cleans up. */
export function createGitTemplateSourceAdapter(deps: GitSourceDeps): TemplateSourceAdapter {
	return {
		async read(descriptor) {
			if (descriptor.kind !== "git") throw new Error("git adapter requires a git descriptor");
			const location = safeGitLocation(descriptor.location);
			let dir: string;
			try {
				dir = await deps.mkdtemp();
			} catch {
				return gitFailure("git-clone-failed", `Failed to clone template source: ${location}`);
			}
			try {
				let clone: GitRunnerResult;
				try {
					clone = await deps.runner(["clone", "--quiet", "--no-hardlinks", location, dir]);
				} catch (error) {
					if (errnoCode(error) === "ENOENT") {
						return gitFailure(
							"git-unavailable",
							"git is not installed or not on PATH; install git or use a local template path",
						);
					}
					return gitFailure("git-clone-failed", `Failed to clone template source: ${location}`);
				}
				if (clone.status !== 0) return classifyCloneFailure(location, `${clone.stderr}\n${clone.stdout}`);

				if (descriptor.ref !== undefined) {
					const checkout = await deps.runner(["-C", dir, "checkout", "--quiet", "--detach", descriptor.ref]);
					if (checkout.status !== 0) {
						const text = checkout.stderr.toLowerCase();
						if (/did not match any|unknown revision|invalid ref|bad revision/.test(text)) {
							return gitFailure(
								"git-ref-not-found",
								`Ref '${descriptor.ref}' not found in template source; check the ref and rerun`,
							);
						}
						return gitFailure("git-checkout-failed", `Failed to check out ref '${descriptor.ref}'`);
					}
				}

				const rev = await deps.runner(["-C", dir, "rev-parse", "HEAD"]);
				if (rev.status !== 0) {
					return gitFailure(
						"git-resolve-failed",
						`Failed to resolve a commit for template source: ${location}`,
					);
				}
				const commit = rev.stdout.trim().toLowerCase();
				if (!COMMIT_HASH.test(commit)) {
					return gitFailure(
						"git-resolve-failed",
						`Failed to resolve a commit for template source: ${location}`,
					);
				}

				const tree = await readTemplateEntries(dir, deps.fs);
				if (!tree.ok) return tree;
				return {
					ok: true,
					entries: tree.entries,
					descriptor: { ...descriptor, location, resolvedCommit: commit },
				};
			} finally {
				await deps.rm(dir);
			}
		},
	};
}

/** Production adapter composition. All process and filesystem effects remain in infra. */
export function createNodeCrewInitTemplateSourceAdapter(): TemplateSourceAdapter {
	const localFs: LocalTemplateFs = {
		readdir: async (dir) => nodeFs.readdir(dir, { withFileTypes: true }),
		readFile: (file) => nodeFs.readFile(file, "utf8"),
	};
	const local = createLocalTemplateSourceAdapter(localFs);
	const git = createGitTemplateSourceAdapter({
		runner: async (args) => {
			try {
				const result = await promisify(execFile)("git", [...args], {
					encoding: "utf8",
					env: {
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_TERMINAL_PROMPT: "0",
						PATH: process.env.PATH ?? "/usr/bin:/bin",
					},
				});
				return { status: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error) {
				if (errnoCode(error) === "ENOENT") throw error;
				const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
				return {
					status: failure.status ?? 1,
					stdout: failure.stdout ?? "",
					stderr: failure.stderr ?? failure.message,
				};
			}
		},
		mkdtemp: () => nodeFs.mkdtemp(path.join(tmpdir(), "bebop-template-")),
		rm: (dir) => nodeFs.rm(dir, { recursive: true, force: true }),
		fs: localFs,
	});
	return {
		read: (descriptor, opts) =>
			descriptor.kind === "local" ? local.read(descriptor, opts) : git.read(descriptor, opts),
	};
}
