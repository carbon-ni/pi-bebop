import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	createMemberIdleWaitFlow,
	MemberIdleWaitFlowError,
	type MemberIdleWaitSurface,
	type MemberIdleWaitTransportResult,
} from "../application/member-idle-wait-flow.ts";
import { formatMemberIdleWaitResult, type MemberIdleWaitResult } from "../domain/index.ts";
import type { SocketState } from "../pi/control-runtime.ts";

const parameters = Type.Object(
	{
		member: Type.String({
			minLength: 1,
			description: "Crew member name or unique role to wait for (exact name when role is ambiguous)",
		}),
		timeout_seconds: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 600,
				description:
					"Bounded wait deadline in seconds (default 300). Timeout is an expected outcome, not a failure.",
			}),
		),
	},
	{ additionalProperties: false },
);
const MAX_OUTPUT = 500;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

export interface MemberIdleWaitToolTransport {
	/** Finite-time endpoint reachability; failure is a compact offline result. */
	readonly probeEndpoint: (socketPath: string) => Promise<boolean>;
	/** Open the one-shot idle subscription and block until a terminal outcome or transport code. */
	readonly requestIdleWait: (
		endpoint: string,
		memberLabel: string,
		options: { timeoutSeconds: number; signal?: AbortSignal },
	) => Promise<MemberIdleWaitTransportResult>;
}

function errorResult(target: string, code: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: `[${target}] ${message.slice(0, MAX_OUTPUT)}` }],
		isError: true,
		details: { error: code },
	};
}

export function registerWaitForMemberIdleTool(
	pi: ExtensionAPI,
	state: SocketState,
	transport: MemberIdleWaitToolTransport,
): void {
	pi.registerTool({
		name: "wait_for_member_idle",
		label: "Wait for Member Idle",
		description:
			"Block once until another crew member's Pi is mechanically idle (runtime settled after run, retry, compaction, and queued continuation), goes offline, or the bounded timeout expires; then resume and choose any reaction. Activity is mechanical and never proves the member saw a message, finished a task, intends to reply, or will stay idle. The wait never starts, steers, interrupts, or aborts the target turn and never reads its conversation. Timeout is an expected coordination outcome, not a failure. For delivery that can wait, prefer send_follow_up.",
		parameters,
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			const membership = state.membershipRuntime?.getMembership() ?? null;
			if (!membership) return errorResult("member", "not-joined", "Not joined to a crew");
			const memberLabel = params.member.trim();
			const timeoutSeconds = typeof params.timeout_seconds === "number" ? params.timeout_seconds : undefined;
			const surface: MemberIdleWaitSurface = {
				getMembership: () => state.membershipRuntime?.getMembership() ?? null,
				isTrusted: () => state.context?.isProjectTrusted?.() === true,
				probeEndpoint: (socketPath) => transport.probeEndpoint(socketPath),
				requestIdleWait: (endpoint, label, options) => transport.requestIdleWait(endpoint, label, options),
				now: () => new Date().toISOString(),
			};
			const flow = createMemberIdleWaitFlow(surface);
			try {
				const result: MemberIdleWaitResult = await flow.waitForMemberIdle({
					member: memberLabel,
					timeoutSeconds,
					signal,
				});
				return {
					content: [{ type: "text", text: formatMemberIdleWaitResult(result).slice(0, MAX_OUTPUT) }],
					details: { result },
				};
			} catch (error) {
				if (error instanceof MemberIdleWaitFlowError)
					return errorResult(memberLabel || "member", error.code, error.message);
				const message = error instanceof Error ? error.message : "Member idle wait failed";
				return errorResult(memberLabel || "member", "transport-error", message);
			}
		},
	});
}
