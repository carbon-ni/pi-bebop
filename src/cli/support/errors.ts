import type { CliResult } from "./output.ts";
import { ExternalIntakeError } from "../../application/external-intake.ts";
import { DirectMessageError } from "../../application/direct-message.ts";

/**
 * Shared CLI error mapping. Operational failures carry stable codes and are
 * presented as plain text on stderr (exit 1) by the single output boundary.
 * Errors never leak stacks — only messages.
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
	return "offline";
}

/** Operational failure result with a stable code and a human message. */
export function errorResult(message: string, target: string, code: string): CliResult {
	return {
		ok: false,
		target,
		status: "error",
		error: { code, message },
	};
}
