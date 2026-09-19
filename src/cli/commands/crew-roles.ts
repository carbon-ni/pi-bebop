import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { CrewManifestError, projectCrewRoles, type CrewManifest } from "../../domain/index.ts";
import { CrewManifestReadError, readTrustedCrewManifest } from "../../infra/crew-manifest-store.ts";
import { getTrustedCrewManifestPaths } from "../../infra/crew-layout.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import { errorResult } from "../support/errors.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome, CliResult } from "../support/output.ts";

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
		.option(
			"--format <format>",
			"Output format: toon (default), json, or text",
			defaultFormatForCommand("crew-roles"),
		)
		.option("--full", "Full response without truncation")
		.addHelpText(
			"after",
			[
				"List the configured crew roles in the project's crew manifest. Read-only",
				"discovery for choosing --crew-role <role> at Pi startup: prints distinct",
				"exact role values in first-manifest-appearance order plus manifest-level",
				"counts. Never starts a server, never joins a member, never mutates files,",
				"and never exposes member names, instructions, socket paths, or session",
				"destinations.",
				"",
				"Manifest resolution: reads .pi/bebop/crew.json (or the .pi/crew",
				"compatibility layout) rooted at the current working directory.",
			].join("\n"),
		);
}

export function readCrewRolesCommand(parsed: Command): CrewRolesCliOptions {
	const opts = parsed.opts<{ format?: string; full?: boolean }>();
	const format = (opts.format ?? defaultFormatForCommand("crew-roles")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return { command: "crew-roles", format, full: opts.full === true };
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

function mapManifestError(error: unknown, manifestPath: string): CliResult {
	if (error instanceof CrewManifestReadError) return errorResult(error.message, manifestPath, error.code);
	if (error instanceof CrewManifestError) return errorResult(error.message, manifestPath, error.code);
	const message = error instanceof Error ? error.message : "Crew manifest read failed";
	return errorResult(message, manifestPath, "operational");
}

export async function runCrewRolesCommand(
	options: CrewRolesCliOptions,
	context: CliContext,
	deps: CrewRolesDependencies = defaultCrewRolesDependencies,
): Promise<CliOutcome> {
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
			result: errorResult(
				"no supported crew manifest found beneath the project",
				projectRoot,
				"missing-manifest",
			),
			format: options.format,
			full: options.full,
		};
	}
	if (existing.length > 1) {
		return {
			kind: "result",
			result: errorResult(
				"both supported crew manifests exist (.pi/bebop and .pi/crew); remove one",
				projectRoot,
				"ambiguous-manifest",
			),
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
