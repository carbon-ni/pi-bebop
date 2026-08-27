import { promises as fs } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import type { CliFormat } from "../arguments.ts";
import { UsageError } from "../arguments.ts";
import { parseFlagTokens } from "../flags.ts";
import type { CliOutcome } from "../output.ts";

/**
 * TASK-0063: `home` handler — compact project state for the no-argument
 * invocation. Pure IO read (one stat), deterministic output, zero network.
 */

function homeExecutable(env: { HOME?: string }, argv1: string | undefined): string {
	if (!argv1) return "pi-bebop";
	return argv1.replace(env.HOME ?? "~", "~");
}

function redactHome(env: { HOME?: string }, value: string): string {
	const home = env.HOME;
	if (!home) return value;
	return value.replace(home, "~");
}

export function buildHomeCommand(): Command {
	return new Command("home")
		.description("Show the next Pi Bebop command")
		.option("--format <format>", "Output format: text (default), json, or toon", "text")
		.showHelpAfterError(false)
		.helpOption(false);
}

export function parseHomeCommand(args: string[]): { command: "home"; format: CliFormat; help?: boolean } {
	const parsed = parseFlagTokens(args, {
		valueFlags: new Set(["--format"]),
		escapedValueFlags: new Set(["--format"]),
	});
	const program = buildHomeCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	try {
		program.parse(parsed.tokens, { from: "user" });
	} catch (error) {
		if (error instanceof CommanderError) {
			if (error.code === "commander.optionMissingArgument") throw new UsageError("Missing value for --format");
			throw new UsageError(error.message);
		}
		throw error;
	}
	const format = program.opts<{ format?: string }>().format ?? "text";
	if (!["toon", "json", "text"].includes(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return { command: "home", format: format as CliFormat, ...(parsed.help ? { help: true } : {}) };
}

export async function runHomeCommand(
	cwd: string,
	commands: readonly string[],
	env: { HOME?: string } = process.env,
	argv1: string | undefined = process.argv[1],
	format: CliFormat = "text",
): Promise<CliOutcome> {
	const project = cwd;
	const scaffoldAbs = path.join(project, ".pi/bebop/crew.json");
	let scaffold: "missing" | "present" = "missing";
	try {
		await fs.stat(scaffoldAbs);
		scaffold = "present";
	} catch {
		scaffold = "missing";
	}
	return {
		kind: "result",
		result: {
			ok: true,
			target: "",
			status: "home",
			data: {
				executable: homeExecutable(env, argv1),
				purpose: "Pi Bebop crew coordination CLI",
				project: redactHome(env, project),
				scaffold,
				commands: [...commands],
				...(scaffold === "missing" ? { next: "pi-bebop crew init" } : { next: "pi --crew-role lead" }),
			},
		},
		format,
		full: false,
	};
}
