import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import {
	addCrewSessionMember,
	captureCrewSession,
	type CrewSessionCaptureOutcome,
	type CrewSessionCaptureDependencies,
} from "../../application/crew-session-capture.ts";
import {
	listCrewSessions,
	showCrewSession,
	type CrewSessionListResult,
	type CrewSessionShowResult,
} from "../../application/crew-session-inspection.ts";
import { getTrustedCrewManifestPaths, isTrustedCrewManifestPath } from "../../infra/crew-layout.ts";
import { CrewSessionStoreError } from "../../infra/crew-session-store.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome, CliResult } from "../support/output.ts";

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export interface CrewSessionCaptureCliOptions {
	readonly command: "crew-session-capture";
	readonly name: string;
	readonly crew?: string;
	readonly format: CliFormat;
	readonly full: boolean;
	readonly help?: boolean;
}

export interface CrewSessionAddCliOptions {
	readonly command: "crew-session-add";
	readonly id: string;
	readonly member: string;
	readonly format: CliFormat;
	readonly full: boolean;
	readonly help?: boolean;
}

export interface CrewSessionListCliOptions {
	readonly command: "crew-session-list";
	readonly crew?: string;
	readonly limit: number;
	readonly offset: number;
	readonly format: CliFormat;
	readonly full: boolean;
	readonly help?: boolean;
}

export interface CrewSessionShowCliOptions {
	readonly command: "crew-session-show";
	readonly id: string;
	readonly format: CliFormat;
	readonly full: boolean;
	readonly help?: boolean;
}

function buildFormatOption(command: string): Command {
	return new Command(command)
		.option("--format <format>", "Output format: toon (default), json, or text", defaultFormatForCommand(command))
		.showHelpAfterError(false)
		.helpOption(false);
}

export function buildCrewSessionCaptureCommand(): Command {
	return buildFormatOption("capture")
		.description("Capture exact online Member Pi Sessions into a local Crew Session")
		.argument("<name>", "non-empty Crew Session name")
		.option("--crew <locator>", "explicit trusted current-project Crew Locator");
}

export function buildCrewSessionAddCommand(): Command {
	return buildFormatOption("add")
		.description("Capture one missing Member into an existing Crew Session")
		.argument("<id>", "exact Crew Session ID")
		.argument("<member>", "exact configured Member name");
}

export function buildCrewSessionListCommand(): Command {
	return buildFormatOption("list")
		.description("List durable Crew Sessions without exposing session-private references")
		.option("--crew <locator>", "filter by one trusted current-project Crew Locator")
		.option("--limit <count>", "maximum results (default: 25)", "25")
		.option("--offset <count>", "number of results to skip", "0");
}

export function buildCrewSessionShowCommand(): Command {
	return buildFormatOption("show")
		.description("Inspect one exact Crew Session and its Member observations")
		.argument("<id>", "exact Crew Session ID");
}

export function crewSessionListHelp(): string {
	return [
		"pi-bebop crew session list [--crew <locator>] [--limit <count>] [--offset <count>] [--format toon|json|text]",
		"",
		"List durable Crew Sessions in stable ID order. Default output redacts Pi Session IDs, files, cwd, and roots.",
		"The command is read-only and never launches Pi, opens a terminal, or repairs records.",
		"",
		"Options:",
		"  --crew <locator>     trusted current-project Crew Locator filter",
		"  --limit <count>      maximum results (default: 25)",
		"  --offset <count>     results to skip (default: 0)",
		"  --format <format>    toon (default), json, or text",
		"",
	].join("\\n");
}

export function crewSessionShowHelp(): string {
	return [
		"pi-bebop crew session show <crew-session-id> [--format toon|json|text]",
		"",
		"Inspect one exact Crew Session in manifest order, including explicit stored session references.",
		"The command is read-only and never launches Pi or modifies session files.",
		"",
	].join("\\n");
}

export function crewSessionCaptureHelp(): string {
	return [
		"pi-bebop crew session capture <name> [--crew <locator>] [--format toon|json|text]",
		"",
		"Explicitly snapshot currently joined online Members into a durable local Crew Session.",
		"Capture before closing the intended Pi sessions. It never guesses recent sessions,",
		"reads conversation content, launches Pi, or starts the whole Crew.",
		"",
		"An explicit --crew Locator must be trusted current-project configuration. Without it,",
		"the canonical current-project crew manifest is selected. A complete or partial capture",
		"exits 0 when at least one Member is valid; capture-empty exits 1 and writes no record.",
		"",
		"Options:",
		"  --crew <locator>     trusted current-project Crew Locator",
		"  --format <format>   toon (default), json, or text",
		"",
		"Examples:",
		'  pi-bebop crew session capture "auth regression"',
		'  pi-bebop crew session capture "release review" --crew .pi/bebop/crew.json --format text',
		"",
	].join("\n");
}

export function crewSessionAddHelp(): string {
	return [
		"pi-bebop crew session add <crew-session-id> <member> [--format toon|json|text]",
		"",
		"Capture one exact currently joined Member into a partial Crew Session.",
		"Existing links are never replaced or rewritten. Resolution and process launch",
		"remain separate explicit operations.",
		"",
		"Options:",
		"  --format <format>   toon (default), json, or text",
		"",
		"Example:",
		"  pi-bebop crew session add cs_0123456789abcdef Alice --format text",
		"",
	].join("\n");
}

function parseWithCommander(
	args: string[],
	program: Command,
): { opts: { format?: string; crew?: string; limit?: string; offset?: string }; args: string[]; help: boolean } {
	const tokens: string[] = [];
	let help = false;
	let seenFormat = false;
	let seenCrew = false;
	for (const raw of args) {
		const equals = raw.indexOf("=");
		const flag = equals > 0 ? raw.slice(0, equals) : raw;
		if (flag === "--help") {
			if (help) throw new UsageError("Duplicate flag: --help");
			help = true;
			continue;
		}
		if (flag === "--format") {
			if (seenFormat) throw new UsageError("Duplicate flag: --format");
			seenFormat = true;
			tokens.push(raw);
			continue;
		}
		if (flag === "--crew") {
			if (seenCrew) throw new UsageError("Duplicate flag: --crew");
			seenCrew = true;
			tokens.push(raw);
			continue;
		}
		tokens.push(raw);
	}
	try {
		program.parse(tokens, { from: "user" });
	} catch (error) {
		if (error instanceof Error && error.name === "CommanderError") {
			const match = /--[a-z-]+/.exec(error.message);
			const flag = match?.[0] ?? "argument";
			throw new UsageError(
				(error as Error & { code?: string }).code === "commander.optionMissingArgument"
					? `Missing value for ${flag}`
					: error.message,
			);
		}
		throw error;
	}
	return { opts: program.opts(), args: program.args, help };
}

function readFormat(opts: { format?: string }): CliFormat {
	const format = (opts.format ?? defaultFormatForCommand("capture")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return format;
}

export function parseCrewSessionCaptureCommand(args: string[], _cwd = process.cwd()): CrewSessionCaptureCliOptions {
	const parsed = parseWithCommander(
		args,
		buildCrewSessionCaptureCommand()
			.exitOverride()
			.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} }),
	);
	if (parsed.args.length !== 1) throw new UsageError("Expected exactly one Crew Session name");
	return {
		command: "crew-session-capture",
		name: parsed.args[0]!,
		...(parsed.opts.crew === undefined ? {} : { crew: parsed.opts.crew }),
		format: readFormat(parsed.opts),
		full: false,
		...(parsed.help ? { help: true } : {}),
	};
}

export function parseCrewSessionAddCommand(args: string[], _cwd = process.cwd()): CrewSessionAddCliOptions {
	const parsed = parseWithCommander(
		args,
		buildCrewSessionAddCommand()
			.exitOverride()
			.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} }),
	);
	if (parsed.args.length !== 2) throw new UsageError("Expected exact Crew Session ID and Member name");
	return {
		command: "crew-session-add",
		id: parsed.args[0]!,
		member: parsed.args[1]!,
		format: readFormat(parsed.opts),
		full: false,
		...(parsed.help ? { help: true } : {}),
	};
}

function readCount(value: string | undefined, label: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (!/^[0-9]+$/.test(value)) throw new UsageError(`Invalid --${label} '${value}'; expected a non-negative integer`);
	return Number(value);
}

export function parseCrewSessionListCommand(args: string[], _cwd = process.cwd()): CrewSessionListCliOptions {
	const parsed = parseWithCommander(
		args,
		buildCrewSessionListCommand()
			.exitOverride()
			.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} }),
	);
	if (parsed.args.length !== 0) throw new UsageError("Crew Session list does not accept positional arguments");
	return {
		command: "crew-session-list",
		...(parsed.opts.crew === undefined ? {} : { crew: parsed.opts.crew }),
		limit: readCount(parsed.opts.limit, "limit", 25),
		offset: readCount(parsed.opts.offset, "offset", 0),
		format: readFormat(parsed.opts),
		full: false,
		...(parsed.help ? { help: true } : {}),
	};
}

export function parseCrewSessionShowCommand(args: string[], _cwd = process.cwd()): CrewSessionShowCliOptions {
	const parsed = parseWithCommander(
		args,
		buildCrewSessionShowCommand()
			.exitOverride()
			.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} }),
	);
	if (parsed.args.length !== 1) throw new UsageError("Expected exactly one Crew Session ID");
	return {
		command: "crew-session-show",
		id: parsed.args[0]!,
		format: readFormat(parsed.opts),
		full: false,
		...(parsed.help ? { help: true } : {}),
	};
}

async function resolveManifestPath(projectRoot: string, requested?: string): Promise<string> {
	if (requested !== undefined) {
		const locator = path.resolve(projectRoot, requested);
		if (!isTrustedCrewManifestPath(locator, projectRoot))
			throw new Error("Crew Locator is outside trusted project layout");
		return locator;
	}
	const candidates = getTrustedCrewManifestPaths(projectRoot);
	const existing: string[] = [];
	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
			existing.push(candidate);
		} catch {
			/* Missing supported layout. */
		}
	}
	if (existing.length === 0) throw new Error("no supported Crew manifest found in the current project");
	if (existing.length > 1) throw new Error("both supported Crew manifests exist; pass one exact --crew Locator");
	return existing[0]!;
}

function resultForOutcome(outcome: CrewSessionCaptureOutcome, target: string): CliResult {
	if ("code" in outcome) {
		return {
			ok: false,
			target,
			status: outcome.code,
			error: {
				code: outcome.code,
				message: outcome.candidateIds?.length
					? `${outcome.message}: ${outcome.candidateIds.join(", ")}`
					: outcome.message,
			},
		};
	}
	const missing = outcome.missing.map(({ name, reason }) => ({ name, reason }));
	return {
		ok: true,
		target: outcome.record.id,
		status: outcome.record.state,
		response: `Crew Session ${outcome.record.id} ${outcome.record.state}: ${outcome.capturedCount}/${outcome.record.members.length} Members captured`,
		data: {
			crewSessionId: outcome.record.id,
			name: outcome.record.name,
			crew: outcome.record.crew.selector ?? outcome.record.crew.locator,
			state: outcome.record.state,
			capturedCount: outcome.capturedCount,
			expectedCount: outcome.record.members.length,
			missing,
		},
	};
}

export interface CrewSessionCliDependencies {
	readonly capture: (
		request: Parameters<typeof captureCrewSession>[0],
		dependencies?: Partial<CrewSessionCaptureDependencies>,
	) => Promise<CrewSessionCaptureOutcome>;
	readonly add: (
		request: Parameters<typeof addCrewSessionMember>[0],
		dependencies?: Partial<CrewSessionCaptureDependencies>,
	) => Promise<CrewSessionCaptureOutcome>;
}

const defaultCliDependencies: CrewSessionCliDependencies = {
	capture: captureCrewSession,
	add: addCrewSessionMember,
};

export async function runCrewSessionCaptureCommand(
	options: CrewSessionCaptureCliOptions,
	context: CliContext,
	dependencies: CrewSessionCliDependencies = defaultCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: crewSessionCaptureHelp() };
	try {
		const projectRoot = path.resolve(context.cwd);
		const manifestPath = await resolveManifestPath(projectRoot, options.crew);
		const outcome = await dependencies.capture({
			name: options.name,
			manifestPath,
			projectRoot,
			signal: context.signal,
		});
		return {
			kind: "result",
			result: resultForOutcome(outcome, options.name),
			format: options.format,
			full: options.full,
		};
	} catch (error) {
		const code = error instanceof CrewSessionStoreError ? error.code : "operational";
		return {
			kind: "result",
			result: {
				ok: false,
				target: options.name,
				status: code,
				error: { code, message: error instanceof Error ? error.message : "Crew Session capture failed" },
			},
			format: options.format,
			full: options.full,
		};
	}
}

function listResult(result: CrewSessionListResult, target: string): CliResult {
	return {
		ok: true,
		target,
		status: result.sessions.length === 0 ? "empty" : "listed",
		response:
			result.sessions.length === 0
				? "No Crew Sessions found"
				: `Listed ${result.returned} of ${result.total} Crew Sessions`,
		data: {
			sessions: result.sessions,
			total: result.total,
			returned: result.returned,
			omitted: result.omitted,
			truncated: result.truncated,
			...(result.sessions.length === 0 ? { next: "pi-bebop crew session capture <name>" } : {}),
		},
	};
}

function showResult(result: CrewSessionShowResult): CliResult {
	return {
		ok: result.state !== "invalid",
		target: result.id,
		status: result.state,
		response: `Crew Session ${result.id} ${result.state}`,
		data: result,
		...(result.state === "invalid"
			? { error: { code: "invalid-record", message: "Crew Session record is invalid" } }
			: {}),
	};
}

export async function runCrewSessionListCommand(
	options: CrewSessionListCliOptions,
	context: CliContext,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: crewSessionListHelp() };
	try {
		const result = await listCrewSessions({
			projectRoot: path.resolve(context.cwd),
			...(options.crew === undefined ? {} : { crewLocator: options.crew }),
			limit: options.limit,
			offset: options.offset,
		});
		return {
			kind: "result",
			result: listResult(result, "crew-sessions"),
			format: options.format,
			full: options.full,
		};
	} catch (error) {
		return {
			kind: "result",
			result: {
				ok: false,
				target: "crew-sessions",
				status: "operational",
				error: {
					code: "operational",
					message: error instanceof Error ? error.message : "Crew Session listing failed",
				},
			},
			format: options.format,
			full: options.full,
		};
	}
}

export async function runCrewSessionShowCommand(
	options: CrewSessionShowCliOptions,
	context: CliContext,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: crewSessionShowHelp() };
	try {
		const result = await showCrewSession(options.id, { projectRoot: path.resolve(context.cwd) });
		return { kind: "result", result: showResult(result), format: options.format, full: options.full };
	} catch (error) {
		return {
			kind: "result",
			result: {
				ok: false,
				target: options.id,
				status: "record-not-found",
				error: {
					code: "record-not-found",
					message: error instanceof Error ? error.message : "Crew Session record was not found",
				},
			},
			format: options.format,
			full: options.full,
		};
	}
}

export async function runCrewSessionAddCommand(
	options: CrewSessionAddCliOptions,
	context: CliContext,
	dependencies: CrewSessionCliDependencies = defaultCliDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: crewSessionAddHelp() };
	try {
		const projectRoot = path.resolve(context.cwd);
		const manifestPath = await resolveManifestPath(projectRoot);
		const outcome = await dependencies.add({
			id: options.id,
			memberName: options.member,
			manifestPath,
			projectRoot,
			signal: context.signal,
		});
		return {
			kind: "result",
			result: resultForOutcome(outcome, options.id),
			format: options.format,
			full: options.full,
		};
	} catch (error) {
		const code = error instanceof CrewSessionStoreError ? error.code : "operational";
		return {
			kind: "result",
			result: {
				ok: false,
				target: options.id,
				status: code,
				error: { code, message: error instanceof Error ? error.message : "Crew Session addition failed" },
			},
			format: options.format,
			full: options.full,
		};
	}
}
