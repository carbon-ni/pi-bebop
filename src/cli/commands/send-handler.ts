import { UsageError, type SendCliOptions } from "../arguments.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";
import { sendHelp } from "./send.ts";
import { readStdinMessage } from "../message-input.ts";
import { deliverDirectMessage } from "./direct-send-adapter.ts";
import { deliverCrewIntake } from "./crew-intake-adapter.ts";
import { errorCode, errorResult } from "../errors.ts";

/**
 * TASK-0063: `send` handler — owns message input, target routing after parser
 * validation, and the uniform operational error mapping. Direct RPC and
 * durable Crew Intake stay in separate adapter modules; the only branch here
 * is the validated target decision (--socket vs --crew).
 */

export interface SendHandlerAdapters {
	readonly readStdin: typeof readStdinMessage;
	readonly deliverDirect: typeof deliverDirectMessage;
	readonly intake: typeof deliverCrewIntake;
}

export const defaultSendHandlerAdapters: SendHandlerAdapters = {
	readStdin: readStdinMessage,
	deliverDirect: deliverDirectMessage,
	intake: deliverCrewIntake,
};

function sendFailureReason(code: string): string {
	if (code === "aborted") return "the send operation was aborted";
	if (code === "timeout") return "the bounded send deadline elapsed";
	if (code === "offline") return "the send endpoint could not be reached";
	return "the send operation could not be completed";
}

export async function runSendCommand(
	options: SendCliOptions,
	context: CliContext,
	adapters: SendHandlerAdapters = defaultSendHandlerAdapters,
): Promise<CliOutcome> {
	const target = options.crewPath ?? options.socketPath ?? "";
	try {
		if (options.help) return { kind: "help", text: sendHelp() };
		let message = options.message;
		if (options.stdin) {
			message = await adapters.readStdin(context.input, context.signal);
			if (message.length === 0)
				throw new UsageError("--stdin received empty input; provide UTF-8 message content");
		}
		if (options.crewPath !== undefined) return await adapters.intake(options, message!, context);
		return await adapters.deliverDirect(options, message!, context.signal);
	} catch (error) {
		if (error instanceof UsageError) throw error;
		const code = errorCode(error);
		return {
			kind: "result",
			result: errorResult(sendFailureReason(code), target, code, "pi-bebop send"),
			format: options.format,
			full: options.full,
		};
	}
}
