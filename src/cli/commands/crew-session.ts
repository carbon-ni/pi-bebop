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
import {
	resolveCrewSessionMember,
	resolutionCommand,
	type CrewSessionResolutionDependencies,
	type CrewSessionResolutionResult,
} from "../../application/crew-session-resolution.ts";
import { getTrustedCrewManifestPaths, isTrustedCrewManifestPath } from "../../infra/crew-layout.ts";
import { CrewSessionStoreError } from "../../infra/crew-session-store.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome, CliResult } from "../support/output.ts";

/**
 * TASK-0209: Crew Session command modules. The Commander builders own the
 * grammar and generated help (guidance in after-help text); the readers own
 * semantic validation only.
 */

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export interface CrewSessionCaptureCliOptions {
	readonly command: "session-capture";
	readonly name: string;
	readonly crew?: string;
	readonly format: CliFormat;
	readonly full: boolean;
}

export interface CrewSessionAddCliOptions {
	readonly command: "session-add";
	readonly id: string;
	readonly member: string;
	readonly format: CliFormat;
	readonly full: boolean;
}

export interface CrewSessionListCliOptions {
	readonly command: "session-list";
	readonly crew?: string;
	readonly limit: number;
	readonly offset: number;
	readonly format: CliFormat;
	readonly full: boolean;
}

export interface CrewSessionShowCliOptions {
	readonly command: "session-show";
	readonly id: string;
	readonly format: CliFormat;
	readonly full: boolean;
}

export interface CrewSessionResolveCliOptions {
	readonly command: "session-resolve";
	readonly id: string;
	readonly member: string;
	readonly format: CliFormat;
	readonly full: boolean;
}

function formatOption(command: string): Command {
	return new Command(command).option(
		"--format <format>",
		"Output format: text (default), toon, or json",
		defaultFormatForCommand(command),
	);
}

export function buildCrewSessionCaptureCommand(): Command {
	return formatOption("capture")
		.description("Capture exact online Member Pi Sessions into a local Crew Session")
		.argument("<name>", "non-empty Crew Session name")
		.option("--crew <locator>", "explicit trusted current-project Crew Locator")
		.addHelpText(
			"after",
			[
				"",
				"Explicitly snapshot currently joined online Members into a durable local Crew Session.",
				"Capture before closing the intended Pi sessions. It never guesses recent sessions,",
				"reads conversation content, launches Pi, or starts the whole Crew.",
				"",
				"An explicit --crew Locator must be trusted current-project configuration. Without it,",
				"the canonical current-project crew manifest is selected. A complete or partial capture",
				"exits 0 when at least one Member is valid; capture-empty exits 1 and writes no record.",
				"",
				"Examples:",
				'  pi-bebop session capture "auth regression"',
				'  pi-bebop session capture "release review" --crew .pi/bebop/crew.json --format text',
			].join("\n"),
		);
}

export function buildCrewSessionAddCommand(): Command {
	return formatOption("add")
		.description("Capture one missing Member into an existing Crew Session")
		.argument("<id>", "exact Crew Session ID")
		.argument("<member>", "exact configured Member name")
		.addHelpText(
			"after",
			[
				"",
				"Capture one exact currently joined Member into a partial Crew Session.",
				"Existing links are never replaced or rewritten. Resolution and process launch",
				"remain separate explicit operations.",
				"",
				"Example:",
				"  pi-bebop session add cs_0123456789abcdef Alice --format text",
			].join("\n"),
		);
}

export function buildCrewSessionListCommand(): Command {
	return formatOption("list")
		.description("List durable Crew Sessions without exposing session-private references")
		.option("--crew <locator>", "filter by one trusted current-project Crew Locator")
		.option("--limit <count>", "maximum results (default: 25)", "25")
		.option("--offset <count>", "number of results to skip", "0")
		.addHelpText(
			"after",
			[
				"",
				"List durable Crew Sessions in stable ID order. Default output redacts Pi Session IDs,",
				"files, cwd, and roots. The command is read-only and never launches Pi, opens a",
				"terminal, or repairs records.",
			].join("\n"),
		);
}

export function buildCrewSessionShowCommand(): Command {
	return formatOption("show")
		.description("Inspect one exact Crew Session and its Member observations")
		.argument("<id>", "exact Crew Session ID")
		.addHelpText(
			"after",
			[
				"",
				"Inspect one exact Crew Session in manifest order, including explicit stored session",
				"references. The command is read-only and never launches Pi or modifies session files.",
			].join("\n"),
		);
}

export function buildCrewSessionResolveCommand(): Command {
	return formatOption("resolve")
		.description("Resolve one exact Member to a manual Pi startup specification")
		.argument("<id>", "exact Crew Session ID")
		.argument("<member>", "exact case-sensitive configured Member name")
		.addHelpText(
			"after",
			[
				"",
				"Validate one exact stored Member Session and print a manual Pi startup specification.",
				"The command never launches Pi, opens a terminal, repairs records, or resumes a Crew.",
				"Run the returned command only after reviewing its exact cwd and session file.",
			].join("\n"),
		);
}

function readFormat(command: Command): CliFormat {
	const format = (command.opts<{ format?: string }>().format ?? defaultFormatForCommand("capture")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return format;
}

export function readCrewSessionCaptureCommand(parsed: Command): CrewSessionCaptureCliOptions {
	const name = parsed.args[0] ?? "";
	if (name.trim().length === 0) throw new UsageError("Expected a non-empty Crew Session name");
	const { crew } = parsed.opts<{ crew?: string }>();
	return {
		command: "session-capture",
		name,
		...(crew === undefined ? {} : { crew }),
		format: readFormat(parsed),
		full: false,
	};
}

export function readCrewSessionAddCommand(parsed: Command): CrewSessionAddCliOptions {
	return {
		command: "session-add",
		id: parsed.args[0]!,
		member: parsed.args[1]!,
		format: readFormat(parsed),
		full: false,
	};
}

function readCount(value: string | undefined, label: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (!/^[0-9]+$/.test(value)) throw new UsageError(`Invalid --${label} '${value}'; expected a non-negative integer`);
	return Number(value);
}

export function readCrewSessionListCommand(parsed: Command): CrewSessionListCliOptions {
	const opts = parsed.opts<{ crew?: string; limit?: string; offset?: string }>();
	if (parsed.args.length > 0) throw new UsageError("Crew Session list does not accept positional arguments");
	return {
		command: "session-list",
		...(opts.crew === undefined ? {} : { crew: opts.crew }),
		limit: readCount(opts.limit, "limit", 25),
		offset: readCount(opts.offset, "offset", 0),
		format: readFormat(parsed),
		full: false,
	};
}

export function readCrewSessionShowCommand(parsed: Command): CrewSessionShowCliOptions {
	return {
		command: "session-show",
		id: parsed.args[0]!,
		format: readFormat(parsed),
		full: false,
	};
}

export function readCrewSessionResolveCommand(parsed: Command): CrewSessionResolveCliOptions {
	return {
		command: "session-resolve",
		id: parsed.args[0]!,
		member: parsed.args[1]!,
		format: readFormat(parsed),
		full: false,
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
			...(result.sessions.length === 0 ? { next: "pi-bebop session capture <name>" } : {}),
		},
	};
}

function resolveResult(result: CrewSessionResolutionResult): CliResult {
	if (result.ok === false)
		return {
			ok: false,
			target: result.code,
			status: result.code,
			response: result.recovery,
			error: { code: result.code, message: result.message },
		};
	return {
		ok: true,
		target: result.crewSessionId,
		status: "resolved",
		response: resolutionCommand(result),
		data: {
			crewSessionId: result.crewSessionId,
			member: result.member,
			argv: result.startup.argv,
			cwd: result.startup.cwd,
			sessionId: result.startup.sessionId,
			sessionFile: result.startup.sessionFile,
			processState: result.startup.processState,
			warning: result.startup.warning,
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

export interface CrewSessionResolveCliDependencies {
	readonly resolve: (
		request: Parameters<typeof resolveCrewSessionMember>[0],
		dependencies?: Partial<CrewSessionResolutionDependencies>,
	) => Promise<CrewSessionResolutionResult>;
}

const defaultResolveCliDependencies: CrewSessionResolveCliDependencies = { resolve: resolveCrewSessionMember };

export async function runCrewSessionResolveCommand(
	options: CrewSessionResolveCliOptions,
	context: CliContext,
	dependencies: CrewSessionResolveCliDependencies = defaultResolveCliDependencies,
): Promise<CliOutcome> {
	try {
		const result = await dependencies.resolve({
			projectRoot: path.resolve(context.cwd),
			id: options.id,
			memberName: options.member,
		});
		return { kind: "result", result: resolveResult(result), format: options.format, full: options.full };
	} catch (error) {
		return {
			kind: "result",
			result: {
				ok: false,
				target: options.id,
				status: "operational",
				error: {
					code: "operational",
					message: error instanceof Error ? error.message : "Crew Session resolution failed",
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
