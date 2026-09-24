import {
	isGetMessageResult,
	isMemberLastMessage,
	MAX_MESSAGE_CONTENT_BYTES,
	type MemberLastMessageResult,
} from "../domain/index.ts";
import type { MemberLastMessageFlowErrorCode } from "../application/member-last-message-flow.ts";
import { resolveMemberEndpoint } from "./socket-endpoint.ts";
import { RpcProtocolError, sendRpcCommand } from "./rpc-client.ts";

export interface MemberLastMessageTransport {
	readonly requestLastMessage: (
		endpoint: string,
		signal?: AbortSignal,
	) => Promise<
		{ ok: true; message: MemberLastMessageResult["message"] } | { ok: false; code: MemberLastMessageFlowErrorCode }
	>;
}

function mapCode(code: string): MemberLastMessageFlowErrorCode {
	const known: readonly MemberLastMessageFlowErrorCode[] = [
		"not-joined",
		"untrusted",
		"unknown-member",
		"ambiguous-member",
		"self-query",
		"remote-rejected",
		"offline-member",
		"message-too-large",
		"malformed-response",
		"timeout",
		"aborted",
		"transport-error",
	];
	return known.includes(code as MemberLastMessageFlowErrorCode)
		? (code as MemberLastMessageFlowErrorCode)
		: "transport-error";
}

function mapTransportError(error: unknown, signal?: AbortSignal): MemberLastMessageFlowErrorCode {
	if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
	if (error instanceof RpcProtocolError) {
		if (["invalid-result", "malformed-response", "mismatched-id"].includes(error.code)) return "malformed-response";
		if (error.code === "remote-error") return mapCode(error.message.replace(/^remote-error:\s*/, ""));
		return mapCode(error.code);
	}
	const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (["ENOENT", "ECONNREFUSED", "ENOTCONN", "ENOTSOCK"].includes(code ?? "")) return "offline-member";
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return "timeout";
	return "transport-error";
}

export function createMemberLastMessageTransport(requestTimeoutMs = 5000): MemberLastMessageTransport {
	return {
		requestLastMessage: async (endpoint, signal) => {
			try {
				const resolved = await resolveMemberEndpoint(endpoint);
				const { response } = await sendRpcCommand(
					resolved,
					{ type: "get_message" },
					{ timeout: requestTimeoutMs, signal },
				);
				if (!response.success) return { ok: false, code: mapCode(response.error ?? "remote-rejected") };
				const rawMessage =
					response.data && typeof response.data === "object" && "message" in response.data
						? (response.data as { message?: unknown }).message
						: undefined;
				if (
					rawMessage &&
					typeof rawMessage === "object" &&
					"content" in rawMessage &&
					typeof rawMessage.content === "string" &&
					Buffer.byteLength(rawMessage.content, "utf8") > MAX_MESSAGE_CONTENT_BYTES
				)
					return { ok: false, code: "message-too-large" };
				if (!isGetMessageResult(response.data)) return { ok: false, code: "malformed-response" };
				const message = response.data.message;
				if (message !== null && !isMemberLastMessage(message)) return { ok: false, code: "malformed-response" };
				return { ok: true, message: message as MemberLastMessageResult["message"] };
			} catch (error) {
				return { ok: false, code: mapTransportError(error, signal) };
			}
		},
	};
}
