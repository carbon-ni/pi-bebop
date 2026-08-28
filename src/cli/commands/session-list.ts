import { promises as fs } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { CONTROL_DIR } from "../../infra/intray-paths.ts";
import { probeMemberEndpoint } from "../../infra/member-endpoint.ts";
import { sendRpcCommand } from "../../infra/rpc-client.ts";
import { isSafeAlias, isSafeSessionId } from "../../domain/index.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { parseFlagTokens } from "../flags.ts";
import { errorResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";

/**
 * TASK-0061: `session list` discovery surface. Bounded, deterministic, and
 * privacy-safe: reports reachable session id, safe aliases, and joined state
 * only. Never messages, prompts, model details, paths, instructions,
 * or tool history. Empty state is explicit with a copyable next step.
 */

export interface SessionListCliOptions {
	readonly command: "session-list";
	readonly format: CliFormat;
	readonly help?: boolean;
}

export type SessionMembership = "joined" | "unjoined" | "unknown";

export interface SessionListEntry {
	readonly sessionId: string;
	readonly aliases: string[];
	readonly membership: SessionMembership;
}

const MAX_FILESYSTEM_ENTRIES = 256;
const MAX_OUTPUT_SESSIONS = 100;
const MAX_ALIASES_PER_SESSION = 8;
const PROBE_TIMEOUT_MS = 500;

export function buildSessionListCommand(): Command {
	return new Command("list")
		.description("List reachable Pi sessions with safe aliases and joined state")
		.option("--format <format>", "Output format: text (default), json, or toon", "text")
		.showHelpAfterError(false)
		.helpOption(false);
}

export function sessionListHelp(): string {
	return [
		"pi-bebop session list [--format toon|json|text]",
		"",
		"List reachable Pi sessions: session id, safe aliases, and joined state",
		"(joined, unjoined, or unknown). Bounded discovery for shell callers;",
		"never exposes socket paths, messages, prompts, model details, instructions,",
		"or tool history.",
		"",
		"Options:",
		"  --format <format>   text (default), json, or toon",
		"",
		"Use the reported session id as --session <id> for member commands.",
		"",
	].join("\n");
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export function parseSessionListCommand(args: string[], _cwd = process.cwd()): SessionListCliOptions {
	const parsed = parseFlagTokens(args, { valueFlags: new Set(["--format"]) });
	const { tokens, help } = parsed;
	const program = buildSessionListCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	let opts: { format?: string };
	try {
		program.parse(tokens, { from: "user" });
		opts = program.opts();
	} catch (error) {
		if (error instanceof CommanderError) {
			const match = /--[a-z-]+/.exec(error.message);
			const flag = match?.[0] ?? "--format";
			throw new UsageError(
				error.code === "commander.optionMissingArgument" ? `Missing value for ${flag}` : error.message,
			);
		}
		throw error;
	}
	const format = (opts.format ?? "text") as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return { command: "session-list", format: format as CliFormat, ...(help ? { help: true } : {}) };
}

export interface SessionListDependencies {
	readonly controlDir: () => string;
	readonly readDir: (dir: string) => Promise<string[]>;
	readonly readAliasTarget: (aliasPath: string) => Promise<string | null>;
	readonly probe: (socketPath: string) => Promise<boolean>;
	readonly queryStatus: (socketPath: string) => Promise<"joined" | "online" | "stopped" | null>;
}

export const defaultSessionListDependencies: SessionListDependencies = {
	controlDir: () => CONTROL_DIR,
	readDir: (dir) => fs.readdir(dir),
	readAliasTarget: async (aliasPath) => {
		try {
			return await fs.readlink(aliasPath);
		} catch {
			return null;
		}
	},
	probe: (socketPath) => probeMemberEndpoint(socketPath, { timeoutMs: PROBE_TIMEOUT_MS }),
	queryStatus: async (socketPath) => {
		try {
			const { response } = await sendRpcCommand(socketPath, { type: "status" }, { timeout: PROBE_TIMEOUT_MS });
			if (!response.success || response.data === undefined) return null;
			const status = (response.data as { status?: string }).status;
			return status === "joined" || status === "online" || status === "stopped" ? status : null;
		} catch {
			return null;
		}
	},
};

export async function runSessionListCommand(
	options: SessionListCliOptions,
	_context: CliContext,
	deps: SessionListDependencies = defaultSessionListDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: sessionListHelp() };
	const dir = deps.controlDir();
	let entries: string[];
	try {
		entries = await deps.readDir(dir);
	} catch {
		return {
			kind: "result",
			result: errorResult(
				`Control store unavailable: ${dir}`,
				"",
				"control-store-unavailable",
				"pi-bebop session list",
			),
			format: options.format,
			full: false,
		};
	}

	const scanned = await scanSessionDirectory(dir, entries, deps);
	const ids = [...scanned.socketIds].sort((a, b) => {
		const primaryA = scanned.aliasesBySession.get(a)?.slice().sort()[0] ?? "";
		const primaryB = scanned.aliasesBySession.get(b)?.slice().sort()[0] ?? "";
		return primaryA === primaryB ? a.localeCompare(b) : primaryA.localeCompare(primaryB);
	});
	const { sessions, omitted } = await collectLiveSessions(ids, scanned.aliasesBySession, scanned.omitted, deps);

	if (sessions.length === 0) {
		return {
			kind: "result",
			result: {
				ok: true,
				target: "",
				status: "empty",
				data: {
					status: "empty",
					sessions: [],
					total: 0,
					omitted: 0,
					next: "start and join a Pi session, then rerun pi-bebop session list",
				},
			},
			format: options.format,
			full: false,
		};
	}
	return {
		kind: "result",
		result: {
			ok: true,
			target: "",
			status: "listed",
			data: { sessions, total: sessions.length, omitted },
		},
		format: options.format,
		full: false,
	};
}

async function scanSessionDirectory(
	dir: string,
	entries: string[],
	deps: SessionListDependencies,
): Promise<{ omitted: number; aliasesBySession: Map<string, string[]>; socketIds: Set<string> }> {
	const omitted = Math.max(0, entries.length - MAX_FILESYSTEM_ENTRIES);
	const aliasesBySession = new Map<string, string[]>();
	const socketIds = new Set<string>();
	for (const entry of entries.slice(0, MAX_FILESYSTEM_ENTRIES)) {
		if (entry.endsWith(".sock")) {
			const id = entry.slice(0, -".sock".length);
			if (isSafeSessionId(id)) socketIds.add(id);
			continue;
		}
		if (!entry.endsWith(".alias")) continue;
		const alias = entry.slice(0, -".alias".length);
		if (!isSafeAlias(alias)) continue;
		const target = await deps.readAliasTarget(path.join(dir, entry));
		if (target === null) continue;
		const base = path.basename(target);
		const id = base.endsWith(".sock") ? base.slice(0, -".sock".length) : base;
		if (!isSafeSessionId(id)) continue;
		const list = aliasesBySession.get(id) ?? [];
		if (list.length < MAX_ALIASES_PER_SESSION) list.push(alias);
		aliasesBySession.set(id, list);
	}
	return { omitted, aliasesBySession, socketIds };
}

async function collectLiveSessions(
	ids: string[],
	aliasesBySession: Map<string, string[]>,
	initialOmitted: number,
	deps: SessionListDependencies,
): Promise<{ sessions: SessionListEntry[]; omitted: number }> {
	const sessions: SessionListEntry[] = [];
	let omitted = initialOmitted;
	for (const id of ids) {
		if (sessions.length >= MAX_OUTPUT_SESSIONS) {
			omitted += 1;
			continue;
		}
		if (!(await deps.probe(getSocketPathOf(id, deps)))) continue;
		const status = await deps.queryStatus(getSocketPathOf(id, deps));
		sessions.push({
			sessionId: id,
			aliases: (aliasesBySession.get(id) ?? []).slice().sort(),
			membership: status === "joined" ? "joined" : status === "online" ? "unjoined" : "unknown",
		});
	}
	return { sessions, omitted };
}

function getSocketPathOf(id: string, deps: SessionListDependencies): string {
	return `${deps.controlDir()}/${id}.sock`;
}
