import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CrewIdleWaitInputSchema,
	createCrewIdleWaitResult,
	resolveCrewIdleSelection,
	type CrewIdleMember,
	type CrewIdleSelection,
	type CrewIdleWaitResult,
} from "../domain/index.ts";
import {
	createCrewIdleWaitFlow,
	CrewIdleWaitFlowError,
	type CrewIdleWaitSurface,
	type CrewIdleStatusTransportResult,
} from "../application/crew-idle-wait-flow.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import { actionableToolError, type ActionableToolResult } from "./actionable-tool-result.ts";

const parameters = CrewIdleWaitInputSchema;

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: unknown;
	terminate?: boolean;
};

export interface CrewIdleWaitToolTransport {
	readonly requestStatus: (member: CrewIdleMember, signal: AbortSignal) => Promise<CrewIdleStatusTransportResult>;
	readonly requestWaitState: CrewIdleWaitSurface["requestWaitState"];
	readonly requestMemberIdle: CrewIdleWaitSurface["requestMemberIdle"];
}

const ERROR_CODES = new Set([
	"aborted",
	"capacity-exceeded",
	"duplicate-member",
	"empty-selection",
	"invalid-selection",
	"invalid-timeout",
	"malformed-response",
	"not-a-member",
	"not-joined",
	"self-member",
	"transport-error",
	"unknown-member",
	"untrusted",
	"wait-in-progress",
	"unexpected-failure",
	"membership-lost",
]);
function normalizeErrorCode(code: string): string {
	return ERROR_CODES.has(code) ? code : "unexpected-failure";
}
function errorResult(code: string, reason: string): ActionableToolResult {
	return actionableToolError({
		code: normalizeErrorCode(code),
		operation: "wait_for_crew_idle",
		reason,
		recovery: ["inspect the scoped Crew membership and target status, then retry the wait."],
	});
}

function renderResult(result: CrewIdleWaitResult): string {
	const scope = result.scope === "all" ? "all other Members" : "selected Members";
	const targets = result.members.map((member) => `${member.name} (${member.role})`).join(", ");
	const blockers = result.blockers
		?.map((item) => `${item.member.name} (${item.member.role}): ${item.status}`)
		.join(", ");
	return `[${scope}] ${result.outcome}${result.reason ? ` — ${result.reason}` : ""} — targets: ${targets || "none"}; coversAllOtherMembers: ${result.coversAllOtherMembers}; observedAt: ${result.observedAt}; caveat: momentary distributed observation, not a whole-Crew atomic state${blockers ? ` — blockers: ${blockers}` : ""}`;
}

export function registerWaitForCrewIdleTool(
	pi: ExtensionAPI,
	state: SocketState,
	transport: CrewIdleWaitToolTransport,
): void {
	pi.registerTool({
		name: "wait_for_crew_idle",
		label: "Wait for Crew Idle",
		description:
			"Block this Lead run until all scoped Crew Members are mechanically idle, a bounded final status round confirms readiness, a target goes offline, the deadline expires, the bounded rounds remain unstable, or a full Crew Idle Lock is observed. Omit members to select every other configured Member; an explicit list is exact-name only and remains in manifest order. A full-roster lock is a coordination signal, not idle, completion, acknowledgement, availability, or willingness. If a Bebop message is accepted for this session, release this wait and process that message first under its original delivery mode. Only one blocking wait may be active locally. This tool never polls, infers tasks, reads conversations, interrupts, redirects, or starts another turn. The final status round is distributed and momentary, not atomic.",
		parameters,
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			const membership = state.membershipRuntime?.getMembership() ?? null;
			let frozenSelection: CrewIdleSelection | undefined;
			if (membership) {
				try {
					frozenSelection = resolveCrewIdleSelection(membership, params.members);
				} catch (error) {
					if (error instanceof Error && "code" in error)
						return errorResult(String(error.code), error.message);
					return errorResult("unexpected-failure", "Crew idle selection failed");
				}
			}
			const lease = state.crewIdleCapacity.acquire();
			if (!lease) return errorResult("wait-in-progress", "Only one blocking wait may be active locally");
			const owned = new AbortController();
			let cleaned = false;
			let wakeListener: ((deliveryId: string) => void) | null = null;
			const cleanup = () => {
				if (cleaned) return;
				cleaned = true;
				if (wakeListener) state.wakeGate.release(wakeListener);
				state.blockingWait.release();
				owned.abort();
				lease.release();
			};
			const wakeResult = new Promise<ToolResult>((resolve) => {
				wakeListener = (deliveryId: string) => {
					void deliveryId;
					cleanup();
					if (!frozenSelection) {
						resolve(
							errorResult(
								"not-joined",
								"Crew idle wait is unavailable because this session is not joined",
							),
						);
						return;
					}
					const result = createCrewIdleWaitResult({
						selection: frozenSelection,
						outcome: "message-received",
						observedAt: new Date().toISOString(),
						reason: "message-received",
					});
					resolve({
						content: [{ type: "text", text: renderResult(result) }],
						details: { result },
						terminate: true,
					});
				};
			});
			const armed = state.wakeGate.arm(wakeListener);
			if (!armed.ok) {
				lease.release();
				return errorResult("wait-in-progress", "Only one blocking wait may be active locally");
			}
			const marker = state.blockingWait.acquire("crew-idle");
			if (!marker.ok) {
				state.wakeGate.release(wakeListener);
				lease.release();
				return errorResult("wait-in-progress", "Only one blocking wait may be active locally");
			}
			if (signal?.aborted) {
				cleanup();
				return errorResult("aborted", "Crew idle wait was aborted");
			}
			const surface: CrewIdleWaitSurface = {
				getMembership: () => state.membershipRuntime?.getMembership() ?? null,
				isTrusted: () => state.context?.isProjectTrusted?.() === true,
				now: () => new Date().toISOString(),
				requestStatus: (member, requestSignal) => transport.requestStatus(member, requestSignal),
				requestWaitState: (member, options) => transport.requestWaitState(member, options),
				requestMemberIdle: (member, options) => transport.requestMemberIdle(member, options),
			};
			const flow = createCrewIdleWaitFlow(surface);
			const wait = flow.wait({
				members: params.members,
				timeout_seconds: params.timeout_seconds,
				callerWait: marker.marker,
				signal: owned.signal,
				selection: frozenSelection,
			});
			const abort = () => owned.abort();
			signal?.addEventListener("abort", abort, { once: true });
			return Promise.race([
				wakeResult,
				wait
					.then((result): ToolResult => {
						cleanup();
						signal?.removeEventListener("abort", abort);
						return { content: [{ type: "text", text: renderResult(result) }], details: { result } };
					})
					.catch((error): ToolResult => {
						cleanup();
						signal?.removeEventListener("abort", abort);
						if (error instanceof CrewIdleWaitFlowError) return errorResult(error.code, error.message);
						return errorResult("transport-error", "Crew idle wait failed");
					}),
			]);
		},
	});
}
