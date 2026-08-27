import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	RepositoryEvidenceAdapterError,
	type RepositoryEvidenceAdapter,
	type RepositoryEvidenceArtifact,
	type RepositoryEvidenceSource,
	type RepositoryEvidenceSourceFailure,
	type RepositoryMechanicalState,
	type RepositoryStateAdapter,
	isTimestampInRetrospectiveInterval,
	type RetrospectiveEvidenceInterval,
} from "../domain/index.ts";

const REPORTS_ROOT = ".tmp/reports";
const VERIFICATION_ROOT = ".tmp/funzzy";
const MAX_SCAN_FILES = 256;
const MAX_SCAN_FILE_BYTES = 64 * 1024;
const MAX_SCAN_AGGREGATE_BYTES = 1024 * 1024;
const GIT_RECORD_SEPARATOR = "\u001e";
const GIT_FIELD_SEPARATOR = "\u001f";

export interface GitCommandRequest {
	readonly cwd: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
}
export type GitCommandRunner = (request: GitCommandRequest) => Promise<string>;
export interface RepositoryFileSnapshot {
	readonly relativePath: string;
	readonly modifiedAt: string;
	readonly content: string;
}
export type RepositoryFileScanResult =
	| {
			readonly status: "available";
			readonly items: readonly RepositoryFileSnapshot[];
			readonly provenance: string;
	  }
	| {
			readonly status: Exclude<RepositoryEvidenceSourceFailure, "timeout">;
			readonly detail: string;
			readonly provenance?: string;
	  };
export type RepositoryFileScanner = (
	relativeRoot: string,
	interval: RetrospectiveEvidenceInterval,
) => Promise<RepositoryFileScanResult>;

export interface LocalRepositoryEvidenceOptions {
	readonly projectRoot: string;
	readonly timeoutMs?: number;
	readonly reportsRoot?: string;
	readonly verificationRoot?: string;
	readonly deps?: {
		readonly runGit?: GitCommandRunner;
		readonly scanFiles?: RepositoryFileScanner;
	};
}
export interface LocalRepositoryEvidenceFactory {
	readonly adapters: readonly RepositoryEvidenceAdapter[];
	readonly state: RepositoryStateAdapter;
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function errorText(error: unknown): string {
	if (!(error instanceof Error)) return "unknown repository adapter failure";
	const value = error.message.replaceAll("\0", "�").trim();
	return value || "repository adapter failed without detail";
}
function isTimeout(error: unknown): boolean {
	return (
		isErrno(error, "ETIMEDOUT") ||
		(typeof error === "object" && error !== null && "signal" in error && error.signal === "SIGTERM")
	);
}
function isDetachedHead(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === 1;
}
function isUnsupportedRepository(error: unknown): boolean {
	return /not a git repository|unknown revision|does not have any commits/i.test(errorText(error));
}

async function defaultRunGit(request: GitCommandRequest): Promise<string> {
	return await new Promise((resolve, reject) => {
		execFile(
			"git",
			[...request.args],
			{
				cwd: request.cwd,
				timeout: request.timeoutMs,
				maxBuffer: MAX_SCAN_AGGREGATE_BYTES,
				encoding: "utf8",
			},
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}
function safeConfiguredRoot(projectRoot: string, relativeRoot: string): string | undefined {
	if (path.isAbsolute(relativeRoot) || relativeRoot.includes("\0")) return undefined;
	const absolute = path.resolve(projectRoot, relativeRoot);
	const relative = path.relative(projectRoot, absolute);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		return undefined;
	return absolute;
}

class FileScanFailure extends Error {
	readonly code: "failed" | "oversized";
	constructor(code: "failed" | "oversized", message: string) {
		super(message);
		this.code = code;
	}
}
async function collectFilePaths(directory: string, output: string[]): Promise<void> {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const target = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new FileScanFailure("failed", "retained source contains a symbolic link");
		if (entry.isDirectory()) await collectFilePaths(target, output);
		else if (entry.isFile()) output.push(target);
		if (output.length > MAX_SCAN_FILES)
			throw new FileScanFailure("oversized", `retained source exceeds ${MAX_SCAN_FILES} files`);
	}
}

async function readFileSnapshots(
	projectRoot: string,
	filePaths: readonly string[],
	interval: RetrospectiveEvidenceInterval,
): Promise<RepositoryFileSnapshot[]> {
	const snapshots: RepositoryFileSnapshot[] = [];
	let aggregateBytes = 0;
	for (const filePath of [...filePaths].sort()) {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) throw new FileScanFailure("failed", "retained source is not a regular file");
		const modifiedAt = stat.mtime.toISOString();
		if (!isTimestampInRetrospectiveInterval(modifiedAt, interval)) continue;
		if (stat.size > MAX_SCAN_FILE_BYTES)
			throw new FileScanFailure("oversized", `retained file exceeds ${MAX_SCAN_FILE_BYTES} bytes`);
		aggregateBytes += stat.size;
		if (aggregateBytes > MAX_SCAN_AGGREGATE_BYTES)
			throw new FileScanFailure("oversized", `retained source exceeds ${MAX_SCAN_AGGREGATE_BYTES} bytes`);
		const bytes = await fs.readFile(filePath);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new FileScanFailure("failed", "retained file is not valid UTF-8");
		}
		snapshots.push({
			relativePath: path.relative(projectRoot, filePath).split(path.sep).join("/"),
			modifiedAt,
			content,
		});
	}
	return snapshots.sort((a, b) =>
		`${a.modifiedAt}:${a.relativePath}`.localeCompare(`${b.modifiedAt}:${b.relativePath}`),
	);
}

export async function scanLocalRepositoryFiles(
	projectRoot: string,
	relativeRoot: string,
	interval: RetrospectiveEvidenceInterval,
): Promise<RepositoryFileScanResult> {
	const configured = safeConfiguredRoot(projectRoot, relativeRoot);
	if (configured === undefined)
		return {
			status: "failed",
			detail: "retention root is not repository-relative",
		};
	try {
		if ((await fs.lstat(configured)).isSymbolicLink())
			return { status: "failed", detail: "retention root is a symbolic link" };
	} catch (error) {
		if (isErrno(error, "ENOENT")) return { status: "missing", detail: "retention root is missing" };
		return { status: "failed", detail: errorText(error) };
	}
	try {
		const paths: string[] = [];
		await collectFilePaths(configured, paths);
		return {
			status: "available",
			items: await readFileSnapshots(projectRoot, paths, interval),
			provenance: `filesystem-snapshot:${relativeRoot}`,
		};
	} catch (error) {
		if (error instanceof FileScanFailure) return { status: error.code, detail: error.message };
		return { status: "failed", detail: errorText(error) };
	}
}

function gitArgs(interval: RetrospectiveEvidenceInterval, plansOnly: boolean): string[] {
	const args = [
		"log",
		`--since=${interval.start}`,
		`--until=${interval.end}`,
		`--format=%x1e%H%x1f%cI%x1f%s`,
		"--no-decorate",
	];
	if (plansOnly) args.push("--name-status", "--", "plans");
	return args;
}
function parseHeader(line: string): {
	hash: string;
	occurredAt: string;
	subject: string;
} {
	const [hash, occurredAt, ...subject] = line.split(GIT_FIELD_SEPARATOR);
	if (!hash || !occurredAt || subject.length === 0)
		throw new RepositoryEvidenceAdapterError("failed", "malformed git log record");
	return {
		hash,
		occurredAt,
		subject: subject.join(GIT_FIELD_SEPARATOR).trim(),
	};
}
function correlation(subject: string, fallback: string): string {
	return subject.match(/\bTASK-\d{4}\b/)?.[0] ?? fallback;
}
function parseCommits(stdout: string): RepositoryEvidenceArtifact[] {
	return stdout
		.split(GIT_RECORD_SEPARATOR)
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const header = parseHeader(record.split("\n", 1)[0]);
			return {
				source: "git-commits",
				id: header.hash,
				occurredAt: header.occurredAt,
				reference: `git:${header.hash}`,
				summary: `commit=${header.hash}; subject=${header.subject}`,
				provenance: "git-log:v1",
				correlationId: correlation(header.subject, `git:${header.hash}`),
			};
		});
}
function parsePlanChanges(stdout: string): RepositoryEvidenceArtifact[] {
	return stdout
		.split(GIT_RECORD_SEPARATOR)
		.map((record) => record.trim())
		.filter(Boolean)
		.flatMap((record) => {
			const [headerLine, ...changes] = record.split("\n").filter(Boolean);
			const header = parseHeader(headerLine);
			return changes.map((change) => {
				const fields = change.split("\t");
				const status = fields[0];
				const relativePath = fields.at(-1) ?? "";
				return {
					source: "plan-lifecycle" as const,
					id: `${header.hash}:${status}:${relativePath}`,
					occurredAt: header.occurredAt,
					reference: `git:${header.hash}:${relativePath}`,
					relativePath,
					summary: `commit=${header.hash}; status=${status}; subject=${header.subject}`,
					provenance: "git-log-name-status:plans:v1",
					correlationId: correlation(`${header.subject} ${relativePath}`, `git:${header.hash}`),
				};
			});
		});
}
function commandFailure(error: unknown): RepositoryEvidenceAdapterError {
	if (isTimeout(error)) return new RepositoryEvidenceAdapterError("timeout", "local git command timed out");
	if (isUnsupportedRepository(error))
		return new RepositoryEvidenceAdapterError("unsupported", "project is not a supported Git repository");
	return new RepositoryEvidenceAdapterError("failed", errorText(error));
}
function gitAdapter(options: {
	source: "git-commits" | "plan-lifecycle";
	projectRoot: string;
	timeoutMs: number;
	runGit: GitCommandRunner;
}): RepositoryEvidenceAdapter {
	return {
		source: options.source,
		capture: async ({ interval }) => {
			try {
				const stdout = await options.runGit({
					cwd: options.projectRoot,
					args: gitArgs(interval, options.source === "plan-lifecycle"),
					timeoutMs: options.timeoutMs,
				});
				return {
					status: "available",
					items: options.source === "git-commits" ? parseCommits(stdout) : parsePlanChanges(stdout),
					provenance: options.source === "git-commits" ? "git-log:v1" : "git-log-name-status:plans:v1",
				};
			} catch (error) {
				throw commandFailure(error);
			}
		},
	};
}
function fileAdapter(options: {
	source: "retained-reports" | "verification";
	root: string;
	scanFiles: RepositoryFileScanner;
}): RepositoryEvidenceAdapter {
	return {
		source: options.source,
		capture: async ({ interval }) => {
			const result = await options.scanFiles(options.root, interval);
			if (result.status !== "available") return result;
			return {
				status: "available",
				provenance: result.provenance,
				items: result.items.map((item) => ({
					source: options.source,
					id: `${item.relativePath}:${item.modifiedAt}`,
					occurredAt: item.modifiedAt,
					reference: item.relativePath,
					relativePath: item.relativePath,
					summary: item.content,
					provenance: `${result.provenance}; mtime=${item.modifiedAt}`,
				})),
			};
		},
	};
}
function gitRequest(projectRoot: string, timeoutMs: number, args: readonly string[]): GitCommandRequest {
	return { cwd: projectRoot, timeoutMs, args };
}
function stateAdapter(projectRoot: string, timeoutMs: number, runGit: GitCommandRunner): RepositoryStateAdapter {
	return async ({ interval }): Promise<RepositoryMechanicalState> => {
		try {
			const head = (await runGit(gitRequest(projectRoot, timeoutMs, ["rev-parse", "HEAD"]))).trim();
			let branch: string | null;
			try {
				branch =
					(
						await runGit(gitRequest(projectRoot, timeoutMs, ["symbolic-ref", "--short", "-q", "HEAD"]))
					).trim() || null;
			} catch (error) {
				if (!isDetachedHead(error)) throw error;
				branch = null;
			}
			const status = await runGit(gitRequest(projectRoot, timeoutMs, ["status", "--porcelain=v1"]));
			const reflog = await runGit(
				gitRequest(projectRoot, timeoutMs, [
					"reflog",
					`--since=${interval.start}`,
					`--until=${interval.end}`,
					"--format=%gs",
				]),
			);
			return {
				head,
				branch,
				dirty: status.trim().length > 0,
				rewritten: /\b(?:rebase|reset|amend)\b/i.test(reflog),
				provenance: "git:rev-parse+symbolic-ref+status+reflog:v1",
			};
		} catch (error) {
			throw commandFailure(error);
		}
	};
}

export function createLocalRepositoryEvidenceAdapters(
	options: LocalRepositoryEvidenceOptions,
): LocalRepositoryEvidenceFactory {
	const projectRoot = path.resolve(options.projectRoot);
	const timeoutMs = options.timeoutMs ?? 5000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
		throw new TypeError("repository command timeout must be positive");
	const runGit = options.deps?.runGit ?? defaultRunGit;
	const scanFiles: RepositoryFileScanner =
		options.deps?.scanFiles ?? ((root, interval) => scanLocalRepositoryFiles(projectRoot, root, interval));
	return {
		adapters: [
			gitAdapter({ source: "git-commits", projectRoot, timeoutMs, runGit }),
			gitAdapter({ source: "plan-lifecycle", projectRoot, timeoutMs, runGit }),
			fileAdapter({
				source: "retained-reports",
				root: options.reportsRoot ?? REPORTS_ROOT,
				scanFiles,
			}),
			fileAdapter({
				source: "verification",
				root: options.verificationRoot ?? VERIFICATION_ROOT,
				scanFiles,
			}),
		],
		state: stateAdapter(projectRoot, timeoutMs, runGit),
	};
}
