import type { ResponsePolicy, ExtractedMessage } from "../domain/index.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { DirectMessageError, sendDirectMessage } from "../application/direct-message.ts";

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
	const wait = request.policy.waitUntil === "turn_end" ? "turn_end" : "accepted";
	let result;
	try {
		result = await sendDirectMessage({
			socketPath: request.socketPath,
			message: request.message,
			mode: request.mode,
			wait,
			timeoutMs: wait === "turn_end" ? 300000 : undefined,
			signal: request.signal,
			sender: request.policy.allowsReply ? request.sender : undefined,
		}, sendRpc);
	} catch (error) {
		if (error instanceof DirectMessageError) return { content: [{ type: "text", text: `Failed: ${error.message}` }], isError: true, details: { error: error.message } };
		throw error;
	}
	if (wait === "turn_end") {
		const lastMessage = result.message as ExtractedMessage | undefined;
		if (!lastMessage) return { content: [{ type: "text", text: "Turn completed but no assistant message found" }], details: { turnIndex: result.turnIndex } };
		return { content: [{ type: "text", text: lastMessage.content }], details: { message: lastMessage, turnIndex: result.turnIndex } };
	}
	if (request.policy.waitUntil === "message_processed" || request.policy.waitUntil === "off") {
		return { content: [{ type: "text", text: `Message delivered to ${request.deliveryTarget ?? "session"}` }], details: result.data };
	}
	return { content: [{ type: "text", text: `Message sent to ${request.displayTarget}` }], details: result.data };
}
