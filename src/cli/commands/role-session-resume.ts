import { Command } from "commander";
import * as path from "node:path";
import {
	discoverRoleSessionCandidates,
	resolveRoleSessionCandidate,
	type RoleSessionResumeDependencies,
	type RoleSessionDiscoveryResult,
} from "../../application/role-session-resume.ts";
import { createPiLauncher, type PiLauncher } from "../../infra/pi-launcher.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome, CliResult } from "../support/output.ts";
import { pickRoleSession, type RoleSessionPickerResult } from "../support/role-session-picker.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

function readFormat(value: string | undefined): CliFormat {
	const format = (value ?? defaultFormatForCommand("session-resume")) as CliFormat;
	if (!FORMATS.includes(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return format;
}

export interface RoleSessionResumeCliOptions {
	readonly command: "session-resume";
	readonly role: string;
	readonly format: CliFormat;
	readonly full: boolean;
	readonly help?: boolean;
}

export function buildRoleSessionResumeCommand(): Command {
	return new Command("resume")
		.description("Select and resume one exact Pi Session attributed to a Crew role")
		.requiredOption("--role <exact-role>", "exact configured role")
		.option(
			"--format <format>",
			"Output format: toon (default), json, or text",
			defaultFormatForCommand("session-resume"),
		);
}

export function roleSessionResumeHelp(): string {
	return [
		"pi-bebop session resume --role <exact-role> [--format toon|json|text]",
		"",
		"Show only existing Pi Sessions explicitly attributed to the exact current Crew role.",
		"Selecting one reopens that exact session with its stored working directory.",
		"Unattributed, inactive, malformed, stale, drifted, and already-online sessions are excluded.",
		"The command never creates a session, opens Pi's native picker, or resumes the whole Crew.",
		"",
	].join("\n");
}

function parseWithCommander(args: readonly string[]): { role?: string; format?: string; help: boolean } {
	const program = buildRoleSessionResumeCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} })
		.option("--help");
	let help = false;
	const tokens: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index]!;
		if (token === "--help" || token === "-h") {
			if (help) throw new UsageError("Duplicate flag: --help");
			help = true;
			continue;
		}
		const flag = token.startsWith("--role=") ? "--role" : token.startsWith("--format=") ? "--format" : token;
		if (flag === "--role" || flag === "--format") {
			if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
			seen.add(flag);
		}
		tokens.push(token);
	}
	if (help) return { ...program.opts(), help };
	try {
		program.parse(tokens, { from: "user" });
	} catch (error) {
		if (error instanceof Error && error.name === "CommanderError") {
			if ((error as Error & { code?: string }).code === "commander.optionMissingArgument")
				throw new UsageError("Missing value for --role or --format");
			throw new UsageError(error.message);
		}
		throw error;
	}
	return { ...program.opts(), help };
}

export function parseRoleSessionResumeCommand(
	args: readonly string[],
	_cwd = process.cwd(),
): RoleSessionResumeCliOptions {
	const parsed = parseWithCommander(args);
	return {
		command: "session-resume",
		role: parsed.role ?? "",
		format: readFormat(parsed.format),
		full: false,
		...(parsed.help ? { help: true } : {}),
	};
}

export interface RoleSessionResumeCliDependencies {
	readonly discover: (
		request: Parameters<typeof discoverRoleSessionCandidates>[0],
		dependencies?: Partial<RoleSessionResumeDependencies>,
	) => Promise<RoleSessionDiscoveryResult>;
	readonly resolve: (
		request: Parameters<typeof resolveRoleSessionCandidate>[0],
		dependencies?: Partial<RoleSessionResumeDependencies>,
	) => ReturnType<typeof resolveRoleSessionCandidate>;
	readonly pick: typeof pickRoleSession;
	readonly launcher: PiLauncher;
}

const defaultDependencies: RoleSessionResumeCliDependencies = {
	discover: discoverRoleSessionCandidates,
	resolve: resolveRoleSessionCandidate,
	pick: pickRoleSession,
	launcher: createPiLauncher(),
};

function failed(target: string, status: string, message: string): CliResult {
	return { ok: false, target, status, error: { code: status, message } };
}

export async function runRoleSessionResumeCommand(
	options: RoleSessionResumeCliOptions,
	context: CliContext,
	dependencies: RoleSessionResumeCliDependencies = defaultDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: roleSessionResumeHelp() };
	const target = options.role;
	try {
		const discovery = await dependencies.discover({ projectRoot: path.resolve(context.cwd), role: options.role });
		if ("code" in discovery)
			return {
				kind: "result",
				result: failed(target, discovery.code, discovery.message),
				format: options.format,
				full: options.full,
			};
		if (discovery.candidates.length === 0)
			return {
				kind: "result",
				result: {
					ok: true,
					target,
					status: "empty",
					response: "No role-attributed Pi Sessions found",
					data: {
						role: discovery.member.role,
						member: discovery.member.name,
						candidates: [],
						skipped: discovery.skipped,
					},
				},
				format: options.format,
				full: options.full,
			};
		const picked: RoleSessionPickerResult = await dependencies.pick(
			discovery.candidates,
			context.input,
			context.output ?? process.stdout,
			context.signal,
		);
		if (picked.kind !== "selected")
			return {
				kind: "result",
				result: { ok: true, target, status: picked.kind, response: "Role Session resume cancelled" },
				format: options.format,
				full: options.full,
			};
		const resolved = await dependencies.resolve(
			{ projectRoot: path.resolve(context.cwd), role: options.role, candidate: picked.candidate },
			{},
		);
		if ("code" in resolved)
			return {
				kind: "result",
				result: failed(target, resolved.code, resolved.message),
				format: options.format,
				full: options.full,
			};
		const launched = await dependencies.launcher.launch({
			sessionFile: resolved.candidate.sessionFile,
			cwd: resolved.candidate.cwd,
			environment: context.environment,
		});
		if ("code" in launched)
			return {
				kind: "result",
				result: failed(target, launched.code, launched.message),
				format: options.format,
				full: options.full,
			};
		return {
			kind: "result",
			result: {
				ok: true,
				target,
				status: "resumed",
				response: `Resumed ${resolved.candidate.name ?? resolved.candidate.sessionId}`,
				data: {
					role: discovery.member.role,
					member: discovery.member.name,
					sessionId: resolved.candidate.sessionId,
				},
			},
			format: options.format,
			full: options.full,
		};
	} catch (error) {
		return {
			kind: "result",
			result: failed(
				target,
				"operational",
				error instanceof Error ? error.message : "Role Session resume failed",
			),
			format: options.format,
			full: options.full,
		};
	}
}
