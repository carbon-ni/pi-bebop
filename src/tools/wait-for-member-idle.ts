import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MemberIdleWaitFlowError } from "../application/member-idle-wait-flow.ts";
import { createMemberIdleWaitResult, formatMemberIdleWaitResult } from "../domain/index.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import { BebopClientError, type InProcessMemberIdleWaitOperation, type MemberIdleWaitResult } from "../sdk/index.ts";

const parameters = Type.Object(
	{
		member: Type.String({
			minLength: 1,
			description: "Crew member name or unique role to wait for (exact name when role is ambiguous)",
		}),
		timeout_seconds: Type.Optional(
			Type.Integer({
				minimum: 60,
				maximum: 7200,
				description:
					"Bounded wait deadline in seconds (default 1800). Timeout is an expected outcome, not a failure.",
			}),
		),
	},
	{ additionalProperties: false },
);
const MAX_OUTPUT = 500;

type IdleWaitTerminal =
	| { readonly ok: true; readonly result: MemberIdleWaitResult }
	| { readonly ok: false; readonly code: string };

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: unknown;
	/** Stop the content-free tool-result continuation so Pi drains the queued message. */
	terminate?: boolean;
};

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
	operation: InProcessMemberIdleWaitOperation,
): void {
	pi.registerTool({
		name: "wait_for_member_idle",
		label: "Wait for Member Idle",
		description:
			"Block this run until the selected member becomes mechanically idle, goes offline, the bounded timeout expires, or a Bebop message (including incoming Member requests) is accepted for this session. An accepted message releases the idle wait and, when this is the only call in the tool batch, is consumed immediately in the next model continuation under its original Follow-up or Redirect mode; it does not imply member idle or task completion. Call this coordination wait alone/sequentially, never in a parallel tool batch: Pi only skips the content-free continuation when every result terminates, so a mixed tool batch may consume the waking message one continuation later. Only one blocking Member Idle Wait may be active locally. Two members waiting on each other's idle may remain blocked until a message, offline event, abort, or timeout. The bounded timeout is always armed: default 1,800 seconds (30 minutes), configurable from 60 to 7,200 seconds. Activity is mechanical and never proves the member saw a message, finished a task, intends to reply, or will stay idle. The wait never starts, steers, interrupts, or aborts the target turn and never reads its conversation. For delivery that can wait, prefer send_follow_up.",
		parameters,
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			const memberLabel = params.member.trim();
			const timeoutSeconds = typeof params.timeout_seconds === "number" ? params.timeout_seconds : undefined;
			try {
				// Resolve the target before arming the local slot. This preserves the
				// synchronous wait-in-progress boundary without duplicating SDK policy.
				const resolved = operation.resolveMemberIdleWait({ member: memberLabel, timeoutSeconds });
				const targetIdentity = { name: resolved.target.name, role: resolved.target.role };
				const observedAt = () => new Date().toISOString();
				const owned = new AbortController();
				const terminal = await new Promise<IdleWaitTerminal>((resolveTerminal) => {
					let settled = false;
					let onAbort: (() => void) | undefined;
					const wakeListener = (deliveryId: string) => {
						void deliveryId;
						owned.abort();
						finish({
							ok: true,
							result: createMemberIdleWaitResult(
								targetIdentity,
								{ outcome: "message-received" },
								observedAt(),
							),
						});
					};
					const cleanup = () => {
						state.wakeGate.release(wakeListener);
						if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
						owned.abort();
					};
					const finish = (outcome: IdleWaitTerminal) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolveTerminal(outcome);
					};
					const armed = state.wakeGate.arm(wakeListener);
					if (armed.ok === false) {
						finish({ ok: false, code: "wait-in-progress" });
						return;
					}
					onAbort = () => finish({ ok: false, code: "aborted" });
					if (signal?.aborted) {
						onAbort();
						return;
					}
					signal?.addEventListener("abort", onAbort, { once: true });
					void operation
						.waitForMemberIdle(memberLabel, {
							timeoutSeconds: resolved.timeoutSeconds,
							signal: owned.signal,
						})
						.then(
							(result) => finish({ ok: true, result }),
							(error) =>
								finish({
									ok: false,
									code:
										error instanceof Error && "code" in error
											? String(error.code)
											: "transport-error",
								}),
						);
				});

				// Map the transport terminal onto the domain outcome union. First
				// terminal wins; every later callback only performed idempotent
				// cleanup. Accepted-message wake releases the wait without changing
				// the message's FIFO/steer delivery mode.
				let result: ReturnType<typeof createMemberIdleWaitResult>;
				if (terminal.ok === true) {
					if (
						terminal.result.member.name !== targetIdentity.name ||
						terminal.result.member.role !== targetIdentity.role
					) {
						return errorResult(
							memberLabel || "member",
							"identity-mismatch",
							"Member idle wait returned a different identity",
						);
					}
					result = terminal.result;
				} else if (terminal.code === "timeout") {
					result = createMemberIdleWaitResult(targetIdentity, { outcome: "timeout" }, observedAt());
				} else if (terminal.code === "wait-in-progress") {
					return errorResult(
						memberLabel || "member",
						"wait-in-progress",
						"Only one blocking Member Idle Wait may be active locally",
					);
				} else if (terminal.code === "aborted") {
					return errorResult(memberLabel || "member", "aborted", "Idle wait aborted by the run");
				} else {
					return errorResult(memberLabel || "member", terminal.code, `Idle wait failed: ${terminal.code}`);
				}
				return {
					content: [{ type: "text", text: formatMemberIdleWaitResult(result).slice(0, MAX_OUTPUT) }],
					details: { result },
					// Pi skips the ordinary tool-result continuation when every result
					// in the batch terminates. This lets the queued Follow-up reach
					// model context before another assistant action can run.
					terminate: result.outcome === "message-received",
				};
			} catch (error) {
				if (error instanceof MemberIdleWaitFlowError)
					return errorResult(memberLabel || "member", error.code, error.message);
				if (error instanceof BebopClientError)
					return errorResult(memberLabel || "member", error.code, error.message);
				const message = error instanceof Error ? error.message : "Member idle wait failed";
				return errorResult(memberLabel || "member", "transport-error", message);
			}
		},
	});
}
