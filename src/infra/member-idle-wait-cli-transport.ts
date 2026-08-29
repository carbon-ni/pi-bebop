import { sendMemberIdleWait, type MemberIdleWaitClientOutcome } from "./rpc-client.ts";
import { resolveMemberEndpoint } from "./socket-endpoint.ts";

export interface MemberIdleWaitCliSource {
	readonly idSocketPath: string;
	readonly aliasSocketPath: string;
}

export type MemberIdleWaitCliOutcome =
	| MemberIdleWaitClientOutcome
	| { readonly ok: false; readonly code: "unknown-session" | "offline-session" };

const STABLE_ERROR_CODES = new Set([
	"timeout",
	"offline",
	"aborted",
	"malformed-response",
	"remote-rejected",
	"transport-error",
	"unknown-session",
	"offline-session",
]);

export function normalizeIdleWaitErrorCode(code: string): string {
	return STABLE_ERROR_CODES.has(code) ? code : "unexpected-failure";
}

export function mapIdleWaitTransportError(error: unknown): MemberIdleWaitCliOutcome {
	if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
	const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (code === "ENOENT") return { ok: false, code: "unknown-session" };
	if (code === "ECONNREFUSED" || code === "ENOTCONN") return { ok: false, code: "offline-session" };
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return { ok: false, code: "timeout" };
	return { ok: false, code: "transport-error" };
}

export function normalizeIdleWaitTransportOutcome(outcome: MemberIdleWaitClientOutcome): MemberIdleWaitCliOutcome {
	if (outcome.ok || !("transportCode" in outcome)) return outcome;
	if (outcome.transportCode === "ENOENT") return { ok: false, code: "unknown-session" };
	if (outcome.transportCode === "ECONNREFUSED" || outcome.transportCode === "ENOTCONN")
		return { ok: false, code: "offline-session" };
	return outcome;
}

async function waitThroughSocket(
	socketPath: string,
	target: string,
	timeoutSeconds: number,
	signal: AbortSignal,
): Promise<MemberIdleWaitCliOutcome> {
	try {
		const resolved = await resolveMemberEndpoint(socketPath);
		return normalizeIdleWaitTransportOutcome(
			await sendMemberIdleWait(
				resolved,
				{ type: "member_idle_wait", member: target },
				{ timeoutSeconds, signal },
			),
		);
	} catch (error) {
		return mapIdleWaitTransportError(error);
	}
}

export async function sendMemberIdleWaitThroughSockets(
	source: MemberIdleWaitCliSource,
	target: string,
	timeoutSeconds: number,
	signal: AbortSignal,
): Promise<MemberIdleWaitCliOutcome> {
	const primary = await waitThroughSocket(source.idSocketPath, target, timeoutSeconds, signal);
	if (primary.ok || !("code" in primary) || primary.code !== "unknown-session") return primary;
	// A stale id socket may have a valid alias; retry exactly once.
	return waitThroughSocket(source.aliasSocketPath, target, timeoutSeconds, signal);
}
