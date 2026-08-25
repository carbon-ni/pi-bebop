import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	createMemberIdleWaitFlow,
	MemberIdleWaitFlowError,
	type MemberIdleWaitSurface,
	type MemberIdleWaitTransportResult,
} from "../application/member-idle-wait-flow.ts";
import { createMemberIdleWaitResult, formatMemberIdleWaitResult } from "../domain/index.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import type { YieldingWaitRuntime } from "../pi/wait-resume.ts";

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
	/** Open the one-shot idle subscription and resolve on the terminal outcome or transport code. */
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
	yieldRuntime: YieldingWaitRuntime,
): void {
	pi.registerTool({
		name: "wait_for_member_idle",
		label: "Wait for Member Idle",
		description:
			"Yield the run and resume once another crew member's Pi is mechanically idle (runtime settled after run, retry, compaction, and queued continuation), goes offline, or the bounded timeout expires. The tool returns a deterministic 'yielded, waiting' result immediately; the terminal outcome arrives in a later turn as a crew-wait-resume message, never while this run stays busy. Activity is mechanical and never proves the member saw a message, finished a task, intends to reply, or will stay idle. The wait never starts, steers, interrupts, or aborts the target turn and never reads its conversation. Timeout is an expected coordination outcome, not a failure. For delivery that can wait, prefer send_follow_up.",
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
				const prepared = await flow.prepareMemberIdleWait({ member: memberLabel, timeoutSeconds });
				if (prepared.kind === "offline") {
					const result = createMemberIdleWaitResult(
						{ name: prepared.target.name, role: prepared.target.role },
						{ outcome: "offline" },
						new Date().toISOString(),
					);
					return {
						content: [{ type: "text", text: formatMemberIdleWaitResult(result).slice(0, MAX_OUTPUT) }],
						details: { result },
					};
				}
				const { target, timeoutSeconds: resolvedTimeout } = prepared;

				// Yield: park the one-shot wait and return immediately; the
				// terminal outcome resumes the run later via crew-wait-resume.
				const parked = yieldRuntime.park({
					kind: "member-idle",
					target: target.name,
					deadlineAt: Date.now() + resolvedTimeout * 1_000,
					sessionId: state.context?.sessionManager?.getSessionId?.(),
				});
				if (parked.ok === false)
					return errorResult(memberLabel || "member", parked.code, `Idle wait park rejected: ${parked.code}`);

				if (signal) {
					if (signal.aborted) yieldRuntime.cancel(parked.id);
					else
						signal.addEventListener(
							"abort",
							() => {
								yieldRuntime.cancel(parked.id);
							},
							{ once: true },
						);
				}

				void surface
					.requestIdleWait(target.socketPath, memberLabel, { timeoutSeconds: resolvedTimeout, signal })
					.then((outcome: MemberIdleWaitTransportResult) => {
						if (outcome.ok === false) {
							yieldRuntime.resolve({
								kind: "member-idle",
								target: target.name,
								outcome: outcome.code,
								observedAt: Date.now(),
							});
							return;
						}
						yieldRuntime.resolve({
							kind: "member-idle",
							target: outcome.result.member.name,
							outcome:
								outcome.result.outcome === "idle" ? outcome.result.disposition : outcome.result.outcome,
							observedAt: Date.now(),
						});
					});

				return {
					content: [
						{
							type: "text",
							text: `[member] ${target.name} idle wait armed; run yielded. You will resume in a later turn with the terminal outcome.`,
						},
					],
					details: {
						yielded: true,
						wait: {
							kind: "member-idle",
							target: target.name,
							deadlineAt: Date.now() + resolvedTimeout * 1_000,
						},
					},
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
