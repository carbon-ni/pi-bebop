import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import { MemberMessageError } from "../application/member-message.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { MemberRequestFlow } from "../application/member-request-flow.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import type { YieldingWaitRuntime } from "../pi/wait-resume.ts";
import { actionableToolError, type ActionableToolResult } from "./actionable-tool-result.ts";

const requestParameters = Type.Object(
	{
		member: Type.String({ minLength: 1, description: "Crew member name or unique role" }),
		message: Type.String({ minLength: 1, description: "Request message requiring exactly one response" }),
		instructions: MessagePayloadSchema.properties.instructions,
		timeout_seconds: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 600,
				description: "Post-idle Response grace in seconds (default 120); starts at the responder's first idle",
			}),
		),
		max_wait_seconds: Type.Optional(
			Type.Integer({
				minimum: 60,
				maximum: 7200,
				description:
					"Absolute accepted-request safety in seconds (default 1800), strictly greater than timeout_seconds",
			}),
		),
	},
	{ additionalProperties: false },
);
const responseParameters = Type.Object(
	{
		message: Type.String({ minLength: 1, description: "Response message" }),
		instructions: MessagePayloadSchema.properties.instructions,
		request_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	},
	{ additionalProperties: false },
);
const emptyParameters = Type.Object({}, { additionalProperties: false });
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

function success(text: string, details: unknown): ToolResult {
	return { content: [{ type: "text", text }], details };
}
const REQUEST_ERROR_CODES = new Set([
	"aborted",
	"ambiguous-member",
	"ambiguous-request",
	"expired",
	"invalid-payload",
	"invalid-request",
	"no-pending-member-requests",
	"no-pending-request",
	"not-joined",
	"offline",
	"response-expired",
	"outcome-unknown",
	"request-failed",
	"target-busy",
	"self-send",
	"timeout",
	"unknown-member",
	"wait-failed",
]);

export function normalizeMemberRequestErrorCode(code: string | undefined): string {
	return code && REQUEST_ERROR_CODES.has(code) ? code : "request-failed";
}

function failure(code: string, _message: string): ActionableToolResult {
	const safeCode = normalizeMemberRequestErrorCode(code);
	return actionableToolError({
		code: safeCode,
		operation: "member_request",
		reason:
			safeCode === "no-pending-member-requests"
				? "no pending outbound request; send_member_request starts a new request"
				: safeCode === "target-busy"
					? "target is busy; use redirect_member for urgent changes or send_to_inbox for durable delivery"
					: "the member request operation was rejected",
		recovery:
			safeCode === "target-busy"
				? [
						"use redirect_member for an urgent next-step change, or send_to_inbox for durable non-interrupting delivery",
					]
				: ["verify the request target and state, then retry the tool."],
	});
}
function flowFor(state: SocketState): MemberRequestFlow {
	if (!state.memberRequestFlow) throw new Error("Crew coordination is not initialized");
	return state.memberRequestFlow;
}

/** TASK-0080: map a terminal Request outcome to its opaque resume marker;
 * timeout carries its reason (timeout:max-wait / timeout:response-after-idle). */
function outcomeMarker(update: {
	readonly kind: string;
	readonly requestId: string;
	readonly reason?: string;
}): string {
	if (update.kind === "timeout") return `timeout:${update.reason ?? "max-wait"}`;
	return update.kind;
}

export function registerSendMemberRequestTool(pi: ExtensionAPI, state: SocketState): void {
	pi.registerTool({
		name: "send_member_request",
		label: "Send Member Request",
		description:
			"Requester-side: send a non-interrupting Member request requiring exactly one correlated Response; you are the Requester and alone wait for its outcome with wait_for_request_outcome. Recommended for any message whose sender requires one answer, report, verdict, or evidence response. Use send_follow_up for information that does not require a Response. Accepted never means answered, completed, correct, authenticated, or progress.",
		parameters: requestParameters,
		async execute(_id, params, signal) {
			try {
				const membership = state.membershipRuntime?.getMembership() ?? null;
				const outcome = await flowFor(state).sendMemberRequest({
					membership,
					member: params.member,
					message: params.message,
					instructions: params.instructions,
					timeoutSeconds: params.timeout_seconds,
					maxWaitSeconds: params.max_wait_seconds,
					signal,
				});
				return success(
					`Request accepted: ${outcome.member.name} (${outcome.member.role}), request_id=${outcome.requestId}`,
					{ requestId: outcome.requestId, member: { name: outcome.member.name, role: outcome.member.role } },
				);
			} catch (error) {
				if (error instanceof MemberMessageError) return failure(error.code, error.message);
				if (error instanceof RpcProtocolError) return failure(error.code, error.message);
				if (error instanceof Error && error.name === "AbortError") return failure("aborted", "Request aborted");
				if (error instanceof Error && /timeout/i.test(error.message)) return failure("timeout", error.message);
				const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
				if (systemCode === "ENOENT" || systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN")
					return failure("offline", "Member request channel is offline");
				return failure("request-failed", error instanceof Error ? error.message : "Request failed");
			}
		},
	});
}

export function registerRespondToMemberRequestTool(pi: ExtensionAPI, state: SocketState): void {
	pi.registerTool({
		name: "respond_to_member_request",
		label: "Respond to Member Request",
		description:
			"Responder-side: send one correlated Response to an inbound Member request you received. Use this only in reply to a Member request you are currently answering, never for ordinary information. With one active request request_id is optional; with multiple, provide the opaque Request ID. This is correlated output, not ordinary send_follow_up.",
		parameters: responseParameters,
		async execute(_id, params) {
			try {
				const membership = state.membershipRuntime?.getMembership();
				if (!membership) return failure("not-joined", "Not joined to a crew");
				await flowFor(state).respondToMemberRequest({
					message: params.message,
					instructions: params.instructions,
					requestId: params.request_id,
					member: { name: membership.member.name, role: membership.member.role },
				});
				return success("Response sent to the active Member request", { requestId: params.request_id });
			} catch (error) {
				const message = error instanceof Error ? error.message : "response-failed";
				const rawCode = message.split(":", 1)[0]!;
				const code = normalizeMemberRequestErrorCode(rawCode);
				if (code === "no-pending-request")
					return failure(code, "No pending Member request; use send_follow_up for ordinary information.");
				if (code === "ambiguous-request") return failure(code, `${message}; provide request_id.`);
				if (code === "response-expired")
					return failure(code, "Request expired; resend as ordinary send_follow_up.");
				return failure(code, "Could not respond to member request");
			}
		},
	});
}

export function registerWaitForRequestOutcomeTool(
	pi: ExtensionAPI,
	state: SocketState,
	yieldRuntime: YieldingWaitRuntime,
): void {
	pi.registerTool({
		name: "wait_for_request_outcome",
		label: "Wait for Request Outcome",
		description:
			"Requester-side: yield the run and resume with the oldest outbound Request event: a correlated Response/offline/timeout or one nonterminal still-pending reminder after 180 seconds. The tool returns a deterministic 'yielded, waiting' result immediately; events arrive in later turns as a crew-wait-resume message, never while this run stays busy. Call only after you sent a Member request; it never handles inbound assignments or ordinary messages. A settled queue returns all-settled normally. It does not poll, monitor, or return unrelated Crew activity, and never proves completion, correctness, progress, or availability.",
		parameters: emptyParameters,
		async execute(_id, _params, signal) {
			try {
				const flow = flowFor(state);
				if (!flow.hasPendingRequestOutcome())
					return success("All outbound Member requests are settled", {
						outcome: "all-settled",
						pending_count: 0,
					});

				// Yield: park the one-shot wait and return immediately; the pump
				// (shared, survives the run) forwards terminal outcomes to the
				// runtime, which resumes the run later via crew-wait-resume.
				const parked = yieldRuntime.park({
					kind: "request-outcome",
					target: "request",
					sessionId: state.context?.sessionManager?.getSessionId?.(),
				});
				if (parked.ok === false)
					return failure(parked.code, `Request outcome wait park rejected: ${parked.code}`);
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

				const pump = () => {
					const waiting = flow.waitForRequestOutcome((update) => {
						yieldRuntime.resolve({
							kind: "request-outcome",
							target: update.requestId,
							outcome: outcomeMarker(update),
							observedAt: Date.now(),
							pending_count: flow.pendingRequestCount(),
							...(update.kind === "response"
								? { response: { message: update.message, instructions: update.instructions } }
								: update.kind === "still-pending"
									? { reminder: { member: update.member, ageSeconds: update.ageSeconds } }
									: {}),
						});
						queueMicrotask(pump);
					});
					if (waiting.ok === false) return;
					if (waiting.kind === "update") {
						yieldRuntime.resolve({
							kind: "request-outcome",
							target: waiting.update.requestId,
							outcome: outcomeMarker(waiting.update),
							observedAt: Date.now(),
							pending_count: flow.pendingRequestCount(),
							...(waiting.update.kind === "response"
								? {
										response: {
											message: waiting.update.message,
											instructions: waiting.update.instructions,
										},
									}
								: waiting.update.kind === "still-pending"
									? {
											reminder: {
												member: waiting.update.member,
												ageSeconds: waiting.update.ageSeconds,
											},
										}
									: {}),
						});
						queueMicrotask(pump);
					}
				};
				pump();

				return success(
					"Request outcome wait armed; run yielded. You will resume in a later turn with the terminal outcome.",
					{
						yielded: true,
						wait: { kind: "request-outcome" },
					},
				);
			} catch {
				return failure("wait-failed", "Could not wait for request outcome");
			}
		},
	});
}
