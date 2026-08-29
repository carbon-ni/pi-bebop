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
import { actionableToolError, type ActionableToolResult } from "./actionable-tool-result.ts";

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

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: unknown;
	/** Stop the content-free tool-result continuation so Pi drains the queued message. */
	terminate?: boolean;
};

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

const IDLE_ERROR_CODES = new Set([
	"aborted",
	"ambiguous-member",
	"capacity-exceeded",
	"invalid-timeout",
	"malformed-response",
	"not-a-member",
	"not-joined",
	"offline",
	"remote-rejected",
	"self-wait",
	"timeout",
	"transport-error",
	"untrusted",
	"unknown-member",
	"wait-in-progress",
	"unexpected-failure",
]);

export function normalizeIdleErrorCode(code: string | undefined): string {
	return code && IDLE_ERROR_CODES.has(code) ? code : "unexpected-failure";
}

function errorResult(target: string, code: string, _message: string): ActionableToolResult {
	code = normalizeIdleErrorCode(code);
	return actionableToolError({
		code,
		operation: "wait_for_member_idle",
		reason: code === "offline" ? "the member endpoint is offline" : "the member idle wait was rejected",
		recovery: ["verify crew membership and the target, then retry the tool."],
		location: { kind: "member", name: "member", value: target },
	});
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
			"Block this run until the selected member becomes mechanically idle, goes offline, the bounded timeout expires, or a Bebop message is accepted for this session. An accepted message releases the idle wait and is consumed immediately in the next model continuation under its original Follow-up or Redirect mode; it does not imply member idle or task completion. Call this coordination wait alone/sequentially, never in a parallel tool batch: its message-received result terminates the content-free continuation so Pi can drain the queued message. Only one blocking Member Idle Wait may be active locally. Two members waiting on each other's idle may remain blocked until a message, offline event, abort, or timeout. The bounded timeout is always armed: default 1,800 seconds (30 minutes), configurable from 60 to 7,200 seconds. Activity is mechanical and never proves the member saw a message, finished a task, intends to reply, or will stay idle. The wait never starts, steers, interrupts, or aborts the target turn and never reads its conversation. For delivery that can wait, prefer send_follow_up.",
		parameters,
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
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
				// TASK-0081: pure resolution (no IO), then acquire the single local
				// slot synchronously BEFORE the reachability probe so a concurrent
				// second wait fails `wait-in-progress` before any IO and never
				// shares, replaces, or opens a subscription.
				const resolved = flow.resolveMemberIdleWait({ member: memberLabel, timeoutSeconds });
				const targetIdentity = { name: resolved.target.name, role: resolved.target.role };
				const observedAt = () => new Date().toISOString();

				const owned = new AbortController();
				const terminal = await new Promise<MemberIdleWaitTransportResult>((resolveTerminal) => {
					let settled = false;
					let cleanedUp = false;
					const finish = (outcome: MemberIdleWaitTransportResult) => {
						if (settled) return;
						settled = true;
						resolveTerminal(outcome);
					};
					// TASK-0117: idempotent cleanup runs on EVERY terminal path — including
					// the accepted-message wake — so the marker and wake gate release
					// deterministically even if transport abort resolution lags.
					const cleanup = () => {
						if (cleanedUp) return;
						cleanedUp = true;
						state.wakeGate.release(wakeListener);
						state.blockingWait.release();
						owned.abort();
					};
					const wakeListener = (deliveryId: string) => {
						void deliveryId;
						cleanup();
						finish({
							ok: true,
							result: createMemberIdleWaitResult(
								targetIdentity,
								{ outcome: "message-received" },
								observedAt(),
							),
						});
					};
					const armed = state.wakeGate.arm(wakeListener);
					if (armed.ok === false) {
						finish({ ok: false, code: "wait-in-progress" });
						return;
					}
					const marker = state.blockingWait.acquire("member-idle");
					if (marker.ok === false) {
						state.wakeGate.release(wakeListener);
						finish({ ok: false, code: "wait-in-progress" });
						return;
					}
					if (signal) {
						if (signal.aborted) {
							cleanup();
							finish({ ok: false, code: "aborted" });
							return;
						}
						signal.addEventListener(
							"abort",
							() => {
								cleanup();
								finish({ ok: false, code: "aborted" });
							},
							{ once: true },
						);
					}
					// Reachability probe (IO) runs AFTER the slot is armed and the marker
					// acquired; offline is a compact offline outcome. Then open the one-shot
					// subscription with the owned controller so a winning local terminal
					// (message/abort) cancels it.
					void (async () => {
						const alive = await surface.probeEndpoint(resolved.target.socketPath);
						if (!alive) {
							cleanup();
							finish({
								ok: true,
								result: createMemberIdleWaitResult(
									targetIdentity,
									{ outcome: "offline" },
									observedAt(),
								),
							});
							return;
						}
						try {
							const outcome = await surface.requestIdleWait(resolved.target.socketPath, memberLabel, {
								timeoutSeconds: resolved.timeoutSeconds,
								signal: owned.signal,
							});
							cleanup();
							finish(outcome);
						} catch {
							cleanup();
							finish({ ok: false, code: "transport-error" });
						}
					})();
				});

				// Map the transport terminal onto the domain outcome union. First
				// terminal wins; every later callback only performed idempotent
				// cleanup. Accepted-message wake resolves BEFORE the unchanged
				// message is submitted; the message keeps its FIFO/steer mode.
				let result: ReturnType<typeof createMemberIdleWaitResult>;
				if (terminal.ok === true) {
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
				const message = error instanceof Error ? error.message : "Member idle wait failed";
				return errorResult(memberLabel || "member", "transport-error", message);
			}
		},
	});
}
