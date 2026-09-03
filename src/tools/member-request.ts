import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatRequestOutcome, MessagePayloadSchema, type RequestOutcome } from "../domain/index.ts";
import { MemberMessageError } from "../application/member-message.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { MemberRequestFlow } from "../application/member-request-flow.ts";
import type { SocketState } from "../pi/control-runtime.ts";

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
type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: unknown;
};

function success(text: string, details: unknown): ToolResult {
	return { content: [{ type: "text", text }], details };
}
function failure(code: string, message: string): ToolResult {
	return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true, details: { error: code } };
}
function flowFor(state: SocketState): MemberRequestFlow {
	if (!state.memberRequestFlow) throw new Error("Crew coordination is not initialized");
	return state.memberRequestFlow;
}

type RequestOutcomeWait =
	| { readonly ok: true; readonly outcome: RequestOutcome }
	| { readonly ok: false; readonly code: "aborted" | "already-waiting" | "no-pending-requests" };

function waitForRequestOutcome(flow: MemberRequestFlow, signal?: AbortSignal): Promise<RequestOutcomeWait> {
	return new Promise((resolve) => {
		let active = true;
		let cancel: (() => void) | undefined;
		const onAbort = () => {
			if (!active) return;
			active = false;
			cancel?.();
			signal?.removeEventListener("abort", onAbort);
			resolve({ ok: false, code: "aborted" });
		};
		const finish = (result: RequestOutcomeWait) => {
			if (!active) return;
			active = false;
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const waiting = flow.waitForRequestOutcome((outcome) => finish({ ok: true, outcome }));
		if (waiting.ok === false) {
			finish({ ok: false, code: waiting.code });
			return;
		}
		if (waiting.kind === "update") {
			finish({ ok: true, outcome: waiting.update });
			return;
		}
		cancel = waiting.cancel;
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
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
				const code = message.split(":", 1)[0]!;
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

export function registerWaitForRequestOutcomeTool(pi: ExtensionAPI, state: SocketState): void {
	pi.registerTool({
		name: "wait_for_request_outcome",
		label: "Wait for Request Outcome",
		description:
			"Requester-side: block this tool call until the oldest terminal outbound Request outcome arrives: Response, offline, timeout(response-after-idle), or timeout(max-wait). Call only after you sent a Member request; it never handles inbound assignments or ordinary messages. The bounded wait is cancellable and does not poll, monitor, or return unrelated Crew activity. It preserves full Response instructions and presents recovery choices without claiming completion, correctness, or availability.",
		parameters: emptyParameters,
		async execute(_id, _params, signal) {
			try {
				const flow = flowFor(state);
				if (!flow.hasPendingRequestOutcome())
					return success("All outbound Member Request outcomes are settled.", { pending_count: 0 });
				const waited = await waitForRequestOutcome(flow, signal);
				if (waited.ok === false) {
					if (waited.code === "no-pending-requests")
						return success("All outbound Member Request outcomes are settled.", { pending_count: 0 });
					if (waited.code === "aborted") return failure("aborted", "Request outcome wait aborted");
					if (waited.code === "already-waiting")
						return failure(waited.code, "Another Request outcome wait is already active");
					return failure("wait-failed", `Could not wait for request outcome: ${waited.code}`);
				}
				return success(formatRequestOutcome(waited.outcome), { result: waited.outcome });
			} catch {
				return failure("wait-failed", "Could not wait for request outcome");
			}
		},
	});
}
