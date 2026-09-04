import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemberMessageError } from "../../application/member-message.ts";
import type { SocketState } from "./types.ts";

export function isStaleContextError(error: unknown): boolean {
	return String(error instanceof Error ? error.message : error).includes("This extension ctx is stale");
}

/** Read the TASK-0069 Pi API without caching or inferring compaction state. */
export function contextIsCompacting(ctx: ExtensionContext): boolean {
	const candidate = ctx as ExtensionContext & { isCompacting?: () => boolean };
	return candidate.isCompacting?.() === true;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isOfflineError(error: unknown): boolean {
	const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	return code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTCONN";
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && /timed? ?out|timeout/i.test(error.message);
}

export function memberMessageErrorCode(error: unknown): string {
	if (error instanceof MemberMessageError) return error.code;
	if (isAbortError(error)) return "aborted";
	if (hasErrorCode(error, "outcome-unknown")) return "outcome-unknown";
	if (isOfflineError(error)) return "offline";
	if (isTimeoutError(error)) return "timeout";
	return "transport-error";
}

export function memberInterruptErrorCode(error: unknown): string {
	const remoteCode = error instanceof Error ? /^remote-error:\s*(\S+)$/.exec(error.message)?.[1] : undefined;
	const targetCodes = new Set([
		"invalid-payload",
		"already-pending",
		"abort-failed",
		"no-context",
		"handoff-failed",
		"aborted",
	]);
	if (isAbortError(error)) return "aborted";
	if (remoteCode !== undefined && targetCodes.has(remoteCode)) return remoteCode;
	if (hasErrorCode(error, "outcome-unknown")) return "outcome-unknown";
	if (isOfflineError(error)) return "offline";
	if (isTimeoutError(error)) return "timeout";
	return "transport-error";
}

export function notifyAcceptedMessage(state: SocketState, deliveryId: string): void {
	if (!state.wakeGate) return;
	state.wakeGate.notifyAccepted(deliveryId);
}
