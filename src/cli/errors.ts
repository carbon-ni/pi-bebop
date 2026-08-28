import type { CliFormat } from "./arguments.ts";
import type { CliResult } from "./output.ts";
import { presentActionableError, type ActionableErrorDescriptor } from "../domain/index.ts";
import { ExternalIntakeError } from "../application/external-intake.ts";
import { DirectMessageError } from "../application/direct-message.ts";

/**
 * TASK-0063: shared CLI error mapping. Stable codes and exit-2 usage results
 * are produced here; rendering stays in the single output boundary
 * (writeOutcome in output.ts). Errors never leak stacks — only messages.
 */

/**
 * Maps any thrown error to the stable public CLI error code. Application
 * codes (intake, direct delivery) win; then explicit abort/timeout/system
 * codes; malformed payloads map to malformed-response; everything else is
 * offline (the conservative transport default).
 */
export function errorCode(error: unknown): string {
	if (error instanceof ExternalIntakeError) return error.code;
	if (error instanceof DirectMessageError) return error.code;
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "EACCES" || systemCode === "EPERM") return "permission-denied";
	if (systemCode === "ENOENT") return "offline";
	if (error instanceof Error && /JSON|malformed|parse/i.test(error.message)) return "malformed-response";
	return "unexpected-failure";
}

/**
 * Usage errors must honor an explicitly requested output format even when
 * parsing fails (TASK-0056 contract edge: both --format json and
 * --format=json forms). Last occurrence wins, consistent with the parser.
 */
export function requestedFormat(args: string[]): CliFormat {
	let format: CliFormat = defaultFormatForCommand(args);
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--format") {
			const value = args[index + 1];
			if (value === "toon" || value === "json" || value === "text") format = value;
		} else if (arg.startsWith("--format=")) {
			const value = arg.slice("--format=".length);
			if (value === "toon" || value === "json" || value === "text") format = value;
		}
	}
	return format;
}

/** Defaults used when parsing fails before a leaf can provide its options. */
function defaultFormatForCommand(args: readonly string[]): CliFormat {
	const [group, leaf] = args;
	if (group === "send") return "toon";
	if (
		group === "member" &&
		(leaf === "follow-up" || leaf === "redirect" || leaf === "inbox" || leaf === "status" || leaf === "wait-idle")
	)
		return "toon";
	if (group === "crew" && leaf === "broadcast") return "toon";
	return "text";
}

function descriptor(code: string, operation: string, reason: string, target?: string): ActionableErrorDescriptor {
	return {
		code,
		operation,
		reason,
		recovery: ["run the command with --help, correct the input, and retry."],
		...(target ? { location: { kind: "argument", name: "target", value: target } } : {}),
	};
}

/** Exit-2 usage result shape (status: usage drives the exit code). */
export function usageResult(message: string, code = "usage"): CliResult {
	return actionableUsageResult(descriptor(code, "pi-bebop command input", message));
}

/** Build an actionable usage result while preserving CLI exit-2 semantics. */
export function actionableUsageResult(descriptor: ActionableErrorDescriptor): CliResult {
	return { ok: false, target: "", status: "usage", error: presentActionableError(descriptor) };
}

/** Build an actionable operational result while preserving CLI exit-1 semantics. */
export function actionableErrorResult(descriptor: ActionableErrorDescriptor): CliResult {
	const error = presentActionableError(descriptor);
	return {
		ok: false,
		target: error.location?.value ?? "",
		status: "error",
		error,
	};
}

/** Operational failure result with a stable code and a human message. */
export function errorResult(
	message: string,
	target: string,
	code: string,
	operation = "pi-bebop operation",
): CliResult {
	const unknownCode = code === "unexpected-failure" || code === "operational";
	const reason = unknownCode ? "an unexpected failure occurred" : message;
	const result = actionableErrorResult(
		descriptor(unknownCode ? "unexpected-failure" : code, operation, reason, target),
	);
	return result;
}
