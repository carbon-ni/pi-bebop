import {
	sendDirectMessage,
	type DirectMessageRequest,
	type DirectMessageResult,
} from "../../application/direct-message.ts";
import type { SendCliOptions } from "../arguments.ts";
import type { CliOutcome } from "../output.ts";

/**
 * TASK-0063: direct RPC send adapter. Owns the application call and the
 * success-result mapping; failures propagate for the send handler to map via
 * the shared error boundary. Keeps direct RPC fully separate from durable
 * Crew Intake routing (the handler decides after target validation).
 */

export interface DirectSendDependencies {
	readonly send: (request: DirectMessageRequest) => Promise<DirectMessageResult>;
}

export const defaultDirectSendDependencies: DirectSendDependencies = {
	send: (request) => sendDirectMessage(request),
};

export async function deliverDirectMessage(
	options: SendCliOptions,
	message: string,
	signal: AbortSignal,
	deps: DirectSendDependencies = defaultDirectSendDependencies,
): Promise<CliOutcome> {
	const result = await deps.send({
		socketPath: options.socketPath!,
		message,
		...(options.instructions.length === 0 ? {} : { instructions: options.instructions }),
		...(options.origin === undefined ? {} : { origin: options.origin }),
		mode: options.mode,
		wait: options.wait,
		timeoutMs: options.timeoutMs,
		signal,
		requireAssistantResponse: true,
	});
	return {
		kind: "result",
		result: {
			ok: true,
			target: options.socketPath!,
			status: result.status,
			response: result.message?.content,
			data: result.data,
			turnIndex: result.turnIndex,
		},
		format: options.format,
		full: options.full,
	};
}
