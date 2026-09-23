import {
	isGetMessageResult,
	isMemberLastMessage,
	MAX_MESSAGE_CONTENT_BYTES,
	type MemberLastMessageResult,
} from "../domain/index.ts";
import type { MemberLastMessageFlowErrorCode } from "../application/member-last-message-flow.ts";
import { probeMemberEndpoint } from "./member-endpoint.ts";
import { resolveMemberEndpoint } from "./socket-endpoint.ts";
import { sendRpcCommand } from "./rpc-client.ts";

export interface MemberLastMessageTransport {
	readonly probeEndpoint: (socketPath: string, signal?: AbortSignal) => Promise<boolean>;
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

export function createMemberLastMessageTransport(probeTimeoutMs = 300): MemberLastMessageTransport {
	return {
		probeEndpoint: (socketPath, signal) => probeMemberEndpoint(socketPath, { timeoutMs: probeTimeoutMs, signal }),
		requestLastMessage: async (endpoint, signal) => {
			try {
				const resolved = await resolveMemberEndpoint(endpoint);
				const { response } = await sendRpcCommand(resolved, { type: "get_message" }, { timeout: 5000, signal });
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
				if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
				const message = error instanceof Error ? error.message : "";
				if (/timed? ?out|timeout/i.test(message)) return { ok: false, code: "timeout" };
				return { ok: false, code: "transport-error" };
			}
		},
	};
}
