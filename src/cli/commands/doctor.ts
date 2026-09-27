import { Command } from "commander";
import {
	DEFAULT_DOCTOR_TIMEOUT_SECONDS,
	MAX_DOCTOR_TIMEOUT_SECONDS,
	MIN_DOCTOR_TIMEOUT_SECONDS,
	diagnoseRuntimeCompatibility,
	type DoctorMemberResult,
	type DoctorResult,
} from "../../application/runtime-doctor.ts";
import { createRuntimeDoctorDependencies } from "../../infra/runtime-doctor.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome } from "../support/output.ts";

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];
function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export interface DoctorCliOptions {
	readonly command: "doctor";
	readonly format: CliFormat;
	readonly timeoutSeconds: number;
	readonly diagnostic: boolean;
	readonly full: boolean;
}

export function buildDoctorCommand(): Command {
	return new Command("doctor")
		.description("Diagnose Crew runtime compatibility without sending messages")
		.option("--format <format>", "Output format: text (default), toon, or json", defaultFormatForCommand("doctor"))
		.option(
			"--timeout <seconds>",
			`Per-Member timeout in seconds (${MIN_DOCTOR_TIMEOUT_SECONDS}-${MAX_DOCTOR_TIMEOUT_SECONDS}; default ${DEFAULT_DOCTOR_TIMEOUT_SECONDS})`,
			String(DEFAULT_DOCTOR_TIMEOUT_SECONDS),
		)
		.option("--diagnostic", "Include safe protocol and capability diagnostics")
		.addHelpText(
			"after",
			[
				"Checks this CLI build, trusted local Crew configuration, and each",
				"discoverable Member runtime through a bounded read-only exchange.",
				"It sends no messages, starts no model turns, and never mutates Crew state.",
				"Package version identifies the installed build; build commit identifies",
				"its source revision; protocol capability identifies what a runtime can do.",
				"The default view shows Crew/Member identities only. --diagnostic adds",
				"safe protocol evidence without credentials or transport topology.",
				"Timeout is bounded to 1-30 seconds per Member and defaults to 2 seconds.",
				"",
				"Examples:",
				"  bebop doctor",
				"  bebop doctor --timeout 10 --format json",
				"  bebop doctor --diagnostic --format toon",
			].join("\n"),
		);
}

export function readDoctorCommand(parsed: Command): DoctorCliOptions {
	const options = parsed.opts<{ format?: string; timeout?: string; diagnostic?: boolean }>();
	const format = (options.format ?? defaultFormatForCommand("doctor")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	const timeoutSeconds = Number(options.timeout ?? DEFAULT_DOCTOR_TIMEOUT_SECONDS);
	if (
		!Number.isInteger(timeoutSeconds) ||
		timeoutSeconds < MIN_DOCTOR_TIMEOUT_SECONDS ||
		timeoutSeconds > MAX_DOCTOR_TIMEOUT_SECONDS
	)
		throw new UsageError(
			`Invalid --timeout '${options.timeout ?? ""}'; use an integer from ${MIN_DOCTOR_TIMEOUT_SECONDS} to ${MAX_DOCTOR_TIMEOUT_SECONDS}`,
		);
	return { command: "doctor", format, timeoutSeconds, diagnostic: options.diagnostic === true, full: false };
}

function memberLine(member: DoctorMemberResult): string {
	const role = member.role ? ` (${member.role})` : "";
	if (member.status === "compatible") return `- ${member.name}${role}: compatible`;
	return `- ${member.name}${role}: ${member.status} — ${member.message ?? "Diagnosis failed."}${member.next ? ` Next: ${member.next}` : ""}`;
}

export function renderDoctorText(result: DoctorResult, diagnostic: boolean): string {
	if (result.status === "empty")
		return "Bebop doctor: no trusted Crews found. Next: run `bebop crew init`, then rerun `bebop doctor`.";
	const lines = [
		`Bebop doctor: ${result.status}.`,
		`CLI: ${result.cli.packageVersion} (protocol ${result.cli.protocol.major}.${result.cli.protocol.minor}).`,
	];
	for (const crew of result.crews) {
		const name = crew.displayName ?? crew.selector ?? "Crew";
		lines.push(`Crew ${name}: ${crew.status}.`);
		if (crew.message) lines.push(`  ${crew.message}${crew.next ? ` Next: ${crew.next}` : ""}`);
		for (const member of crew.members) {
			lines.push(`  ${memberLine(member)}`);
			if (diagnostic && member.protocol)
				lines.push(
					`  Diagnostic ${member.name}: protocol ${member.protocol.major}.${member.protocol.minor}, package ${member.packageVersion ?? "unknown"}, commit ${member.buildCommit ?? "unknown"}.`,
				);
			if (diagnostic && member.capabilities)
				lines.push(`  Capabilities ${member.name}: ${member.capabilities.join(", ")}.`);
			if (diagnostic && member.missingCapabilities)
				lines.push(`  Missing capabilities ${member.name}: ${member.missingCapabilities.join(", ")}.`);
		}
	}
	return lines.join("\n");
}

export async function runDoctorCommand(
	options: DoctorCliOptions,
	context: CliContext,
	deps = createRuntimeDoctorDependencies(),
): Promise<CliOutcome> {
	const result = await diagnoseRuntimeCompatibility(
		{
			projectRoot: context.cwd,
			timeoutSeconds: options.timeoutSeconds,
			diagnostic: options.diagnostic,
			signal: context.signal,
		},
		deps,
	);
	return {
		kind: "result",
		result: {
			ok: true,
			target: "Crew runtimes",
			status: result.status,
			response: renderDoctorText(result, options.diagnostic),
			data: result,
		},
		format: options.format,
		full: options.full,
	};
}
