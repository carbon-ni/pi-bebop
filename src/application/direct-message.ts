import { appendSenderMetadata, type ExtractedMessage, type RpcSendCommand } from "../domain/index.ts";
import { sendRpcCommand, type RpcClientOptions } from "../infra/rpc-client.ts";

export type DirectMessageWait = "turn_end" | "accepted";

export interface DirectMessageRequest {
	readonly socketPath: string;
	readonly message: string;
	readonly mode: "steer" | "follow_up";
	readonly wait: DirectMessageWait;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly sender?: { sessionId: string; sessionName?: string };
}

export class DirectMessageError extends Error {
	readonly code: "remote-rejected" | "missing-response";
	constructor(code: "remote-rejected" | "missing-response", message: string) {
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
	const command: RpcSendCommand = {
		type: "send",
		message: appendSenderMetadata(request.message, request.sender ?? null),
		mode: request.mode,
	};
	const options: RpcClientOptions = request.wait === "turn_end"
		? { ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }), waitForEvent: "turn_end", signal: request.signal }
		: { ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }), signal: request.signal };
	const result = await sendRpc(request.socketPath, command, options);
	if (!result.response.success) throw new DirectMessageError("remote-rejected", result.response.error ?? "Remote endpoint rejected the message");
	if (request.wait === "accepted") return { status: "accepted", data: result.response.data };
	return {
		status: "completed",
		...(result.event?.message === undefined ? {} : { message: result.event.message }),
		...(result.event?.turnIndex === undefined ? {} : { turnIndex: result.event.turnIndex }),
	};
}
