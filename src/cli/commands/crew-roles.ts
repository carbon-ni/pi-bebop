import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Command, CommanderError } from "commander";
import { CrewManifestError, projectCrewRoles, type CrewManifest } from "../../domain/index.ts";
import { CrewManifestReadError, readTrustedCrewManifest } from "../../infra/crew-manifest-store.ts";
import { getTrustedCrewManifestPaths } from "../../infra/crew-layout.ts";
import { UsageError, type CliFormat } from "../arguments.ts";
import { parseFlagTokens } from "../flags.ts";
import { actionableErrorResult } from "../errors.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome, CliResult } from "../output.ts";

/**
 * TASK-0082: `crew roles` discovery leaf — one registry contribution owning
 * its vocabulary, schema, help, parser, and handler adapter. Read-only role
 * discovery for choosing `pi --crew-role <role>` at startup: reads the
 * supported project-local crew manifest rooted at the explicit CLI working
 * directory, prints distinct exact role values in first-manifest-appearance
 * order plus manifest-level counts, and exits 0 without starting a server,
 * joining a member, or mutating files. Never exposes member names,
 * instructions, socket paths, or global session destinations.
 */

export interface CrewRolesCliOptions {
	readonly command: "crew-roles";
	readonly format: CliFormat;
	/** Common boolean flag; accepted for parity, no command-specific formatting. */
	readonly full: boolean;
	readonly help?: boolean;
}

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

export function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

/** Declarative Commander schema for `crew roles` — the single flag definition. */
export function buildCrewRolesCommand(): Command {
	return new Command("roles")
		.description("List configured crew roles (read-only discovery)")
		.option("--format <format>", "Output format: text (default), json, or toon", "text")
		.option("--full", "Full response without truncation")
		.showHelpAfterError(false)
		.helpOption(false); // --help handled by the app pre-pass; no short aliases
}

export function crewRolesHelp(): string {
	return [
		"pi-bebop crew roles [--format toon|json|text] [--full]",
		"",
		"List the configured crew roles in the project's crew manifest. Read-only",
		"discovery for choosing --crew-role <role> at Pi startup: prints distinct",
		"exact role values in first-manifest-appearance order plus manifest-level",
		"counts. Never starts a server, never joins a member, never mutates files,",
		"and never exposes member names, instructions, socket paths, or session",
		"destinations.",
		"",
		"Options:",
		"  --format <format>   text (default), json, or toon",
		"  --full              Full response without truncation",
		"",
		"Manifest resolution: reads .pi/bebop/crew.json (or the .pi/crew",
		"compatibility layout) rooted at the current working directory.",
		"",
	].join("\n");
}

export function parseCrewRolesCommand(args: string[], _cwd = process.cwd()): CrewRolesCliOptions {
	const parsed = parseFlagTokens(args, {
		valueFlags: new Set(["--format"]),
		booleanFlags: new Set(["--full"]),
	});
	const { tokens, help } = parsed;
	const full = parsed.seen.has("--full");

	// Commander tokenization with injected argv and no ambient IO.
	const program = buildCrewRolesCommand()
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

	// App-owned enum validation.
	const format = (opts.format ?? "text") as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return { command: "crew-roles", format: format as CliFormat, full, ...(help ? { help: true } : {}) };
}

/** Injected filesystem surface: deterministic, no raw IO, no Pi runtime. */
export interface CrewRolesDependencies {
	readonly manifestExists: (manifestPath: string) => Promise<boolean>;
	readonly readManifest: (manifestPath: string, projectRoot: string) => Promise<CrewManifest>;
}

export const defaultCrewRolesDependencies: CrewRolesDependencies = {
	manifestExists: async (manifestPath) => {
		try {
			await fs.access(manifestPath);
			return true;
		} catch {
			return false;
		}
	},
	// Caller-consent framing (TASK-0040): the explicit CLI working directory is
	// the consent. The trusted store re-validates the exact layout and the
	// full manifest parsing/instruction rules; we never report Pi-trust.
	readManifest: (manifestPath, projectRoot) => readTrustedCrewManifest(manifestPath, projectRoot, () => true),
};

function mapManifestError(error: unknown, _manifestPath: string): CliResult {
	const known = error instanceof CrewManifestReadError || error instanceof CrewManifestError;
	const code = known ? error.code : "unexpected-failure";
	return actionableErrorResult({
		code,
		operation: "pi-bebop crew roles",
		reason:
			known && error instanceof CrewManifestReadError
				? "the configured Crew manifest could not be read"
				: known
					? "the configured Crew manifest is invalid"
					: "an unexpected failure occurred",
		recovery: ["verify the project Crew manifest and retry pi-bebop crew roles."],
		location: { kind: "config-field", name: "Crew manifest" },
	});
}

export async function runCrewRolesCommand(
	options: CrewRolesCliOptions,
	context: CliContext,
	deps: CrewRolesDependencies = defaultCrewRolesDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: crewRolesHelp() };
	const projectRoot = path.resolve(context.cwd);
	const manifestPaths = getTrustedCrewManifestPaths(projectRoot);
	const existing = (
		await Promise.all(
			manifestPaths.map(async (manifestPath) => ({
				manifestPath,
				exists: await deps.manifestExists(manifestPath),
			})),
		)
	).filter((item) => item.exists);
	if (existing.length === 0) {
		return {
			kind: "result",
			result: actionableErrorResult({
				code: "missing-manifest",
				operation: "pi-bebop crew roles",
				reason: "no supported crew manifest found beneath the project",
				recovery: ["create a Crew manifest with pi-bebop crew init, then retry pi-bebop crew roles."],
				location: { kind: "project-path", name: "project", value: "." },
			}),
			format: options.format,
			full: options.full,
		};
	}
	if (existing.length > 1) {
		return {
			kind: "result",
			result: actionableErrorResult({
				code: "ambiguous-manifest",
				operation: "pi-bebop crew roles",
				reason: "both supported crew manifests exist (.pi/bebop and .pi/crew); remove one",
				recovery: ["remove one supported Crew manifest, then retry pi-bebop crew roles."],
				location: { kind: "project-path", name: "project", value: "." },
			}),
			format: options.format,
			full: options.full,
		};
	}
	const manifestPath = existing[0]!.manifestPath;
	let manifest: CrewManifest;
	try {
		manifest = await deps.readManifest(manifestPath, projectRoot);
	} catch (error) {
		return {
			kind: "result",
			result: mapManifestError(error, manifestPath),
			format: options.format,
			full: options.full,
		};
	}
	const projection = projectCrewRoles(manifest);
	const roles = [...projection.roles];
	return {
		kind: "result",
		result: {
			ok: true,
			target: manifestPath,
			status: "listed",
			response: `${projection.roleCount} configured role${projection.roleCount === 1 ? "" : "s"}: ${roles.join(", ")}`,
			data: { roles, roleCount: projection.roleCount, memberCount: projection.memberCount },
		},
		format: options.format,
		full: options.full,
	};
}
