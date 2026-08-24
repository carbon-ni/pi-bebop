import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import { MemberMessageError } from "../application/member-message.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { CrewUpdateFlow } from "../application/crew-update-flow.ts";
import type { SocketState } from "../pi/control-runtime.ts";

const requestParameters = Type.Object(
	{
		member: Type.String({ minLength: 1, description: "Crew member name or unique role" }),
		message: Type.String({ minLength: 1, description: "Request message requiring exactly one response" }),
		instructions: MessagePayloadSchema.properties.instructions,
		timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
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
function failure(code: string, message: string): ToolResult {
	return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true, details: { error: code } };
}
function flowFor(state: SocketState): CrewUpdateFlow {
	if (!state.crewUpdateFlow) throw new Error("Crew coordination is not initialized");
	return state.crewUpdateFlow;
}

export function registerRequestMemberTool(pi: ExtensionAPI, state: SocketState): void {
	pi.registerTool({
		name: "request_member",
		label: "Request Member",
		description:
			"Send a normal non-interrupting request when exactly one response is required; returns an accepted request id immediately. Use send_follow_up for information that does not require a response.",
		parameters: requestParameters,
		async execute(_id, params, signal) {
			try {
				const membership = state.membershipRuntime?.getMembership() ?? null;
				const outcome = await flowFor(state).requestMember({
					membership,
					member: params.member,
					message: params.message,
					instructions: params.instructions,
					timeoutSeconds: params.timeout_seconds,
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
			"Respond to an active request using its request context. With one active request request_id is optional; with multiple, provide request_id. This is a correlated response, not ordinary send_follow_up.",
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
				return success("Response sent to the active member request", { requestId: params.request_id });
			} catch (error) {
				const message = error instanceof Error ? error.message : "response-failed";
				const code = message.split(":", 1)[0]!;
				if (code === "no-pending-request")
					return failure(code, "No pending member request; use send_follow_up for an ordinary message.");
				if (code === "ambiguous-request") return failure(code, `${message}; provide request_id.`);
				if (code === "response-expired")
					return failure(code, "Request expired; resend as ordinary send_follow_up.");
				return failure(code, "Could not respond to member request");
			}
		},
	});
}

export function registerWaitForCrewUpdateTool(pi: ExtensionAPI, state: SocketState): void {
	pi.registerTool({
		name: "wait_for_crew_update",
		label: "Wait for Crew Update",
		description:
			"Wait for the next terminal response, idle-without-response, offline, or timeout from a member request. Use only when no immediate coordination action remains; it does not poll or infer task completion.",
		parameters: emptyParameters,
		async execute(_id, _params, signal) {
			const flow = flowFor(state);
			try {
				let resolveWait!: (result: { update?: unknown; error?: string }) => void;
				const resultPromise = new Promise<{ update?: unknown; error?: string }>((resolve) => {
					resolveWait = resolve;
				});
				const waiting = flow.waitForCrewUpdate((update) => resolveWait({ update }));
				if (waiting.ok === false)
					return failure(
						waiting.code,
						waiting.code === "already-waiting"
							? "Another wait is already active"
							: "No pending requests; continue ready work or stop",
					);
				if (waiting.kind === "update") return success("Crew update received", waiting.update);
				const cancel = () => {
					waiting.cancel();
					resolveWait({ error: "aborted" });
				};
				if (signal?.aborted) {
					cancel();
				} else signal?.addEventListener("abort", cancel, { once: true });
				const result = await resultPromise;
				signal?.removeEventListener("abort", cancel);
				if (result.error)
					return failure(result.error, "Wait cancelled; pending requests and buffered updates remain");
				return success("Crew update received", result.update);
			} catch {
				return failure("wait-failed", "Could not wait for crew update");
			}
		},
	});
}
