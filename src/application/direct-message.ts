import { isMessagePayload, type ExtractedMessage, type MessageOrigin, type RpcSendCommand } from "../domain/index.ts";
import { sendRpcCommand, type RpcClientOptions } from "../infra/rpc-client.ts";

export type DirectMessageWait = "turn_end" | "accepted";

export interface DirectMessageRequest {
	readonly socketPath: string;
	readonly message: string;
	readonly mode: "steer" | "follow_up";
	readonly wait: DirectMessageWait;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly instructions?: readonly string[];
	readonly origin?: MessageOrigin;
	readonly sender?: { sessionId: string; sessionName?: string }; // callback routing only
}

export class DirectMessageError extends Error {
	readonly code: "remote-rejected" | "uncorrelated-response";
	constructor(code: "remote-rejected" | "uncorrelated-response", message: string) {
		super(message);
		this.name = "DirectMessageError";
		this.code = code;
	}
}

export interface DirectMessageResult {
	readonly status: "accepted" | "completed";
	readonly data?: unknown;
	readonly message?: ExtractedMessage;
	readonly turnIndex?: number;
}

export async function sendDirectMessage(
	request: DirectMessageRequest,
	sendRpc: typeof sendRpcCommand = sendRpcCommand,
): Promise<DirectMessageResult> {
	const payload = {
		content: request.message,
		...(request.instructions === undefined ? {} : { instructions: [...request.instructions] }),
		...(request.origin === undefined ? {} : { origin: request.origin }),
		...(request.sender === undefined ? {} : { replyTo: request.sender }),
	};
	if (!isMessagePayload(payload))
		throw new DirectMessageError("remote-rejected", "Invalid structured message payload");
	if (request.wait === "turn_end") {
		throw new DirectMessageError(
			"uncorrelated-response",
			"turn_end is not delivery-correlated; use send_member_request or pi-bebop ask <crew[/member]> for a correlated response",
		);
	}
	const command: RpcSendCommand = {
		type: "send",
		payload,
		delivery: request.mode === "steer" ? "immediate" : "follow_up",
	};
	const options: RpcClientOptions = {
		...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
		signal: request.signal,
	};
	const result = await sendRpc(request.socketPath, command, options);
	if (!result.response.success)
		throw new DirectMessageError(
			"remote-rejected",
			result.response.error ?? "Remote endpoint rejected the message",
		);
	if (request.wait === "accepted")
		return {
			status: "accepted",
			...(result.response.data === undefined ? {} : { data: result.response.data }),
		};
	return { status: "completed" };
}
