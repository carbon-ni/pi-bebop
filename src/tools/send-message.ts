import type { ResponsePolicy, RpcSendCommand, ExtractedMessage } from "../domain/index.ts";
import { appendSenderMetadata } from "../domain/index.ts";
import { sendRpcCommand, type RpcClientOptions } from "../infra/rpc-client.ts";

export interface MessageToolResult {
	readonly content: Array<{ type: "text"; text: string }>;
	readonly isError?: boolean;
	readonly details: unknown;
}

export interface SendMessageRequest {
	readonly socketPath: string;
	readonly message: string;
	readonly mode: "steer" | "follow_up";
	readonly policy: ResponsePolicy;
	readonly sender?: { sessionId: string; sessionName?: string };
	readonly signal?: AbortSignal;
	readonly displayTarget: string;
	readonly deliveryTarget?: string;
}

export async function sendMessageToSocket(request: SendMessageRequest, sendRpc: typeof sendRpcCommand = sendRpcCommand): Promise<MessageToolResult> {
	const message = appendSenderMetadata(request.message, request.policy.allowsReply ? request.sender ?? null : null);
	const command: RpcSendCommand = { type: "send", message, mode: request.mode };
	let options: RpcClientOptions = { signal: request.signal };
	if (request.policy.waitUntil === "turn_end") options = { timeout: 300000, waitForEvent: "turn_end", signal: request.signal };
	const result = await sendRpc(request.socketPath, command, options);
	if (!result.response.success) {
		return { content: [{ type: "text", text: `Failed: ${result.response.error ?? "unknown error"}` }], isError: true, details: result };
	}
	if (request.policy.waitUntil === "turn_end") {
		const lastMessage = result.event?.message as ExtractedMessage | undefined;
		if (!lastMessage) return { content: [{ type: "text", text: "Turn completed but no assistant message found" }], details: { turnIndex: result.event?.turnIndex } };
		return { content: [{ type: "text", text: lastMessage.content }], details: { message: lastMessage, turnIndex: result.event?.turnIndex } };
	}
	if (request.policy.waitUntil === "message_processed" || request.policy.waitUntil === "off") {
		return { content: [{ type: "text", text: `Message delivered to ${request.deliveryTarget ?? "session"}` }], details: result.response.data };
	}
	return { content: [{ type: "text", text: `Message sent to ${request.displayTarget}` }], details: result.response.data };
}
