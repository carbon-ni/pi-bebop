export interface RpcResponse {
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
	id?: string;
}

export interface RpcEvent {
	type: "event";
	event: string;
	data?: unknown;
	subscriptionId?: string;
}

export interface RpcSendCommand {
	type: "send";
	message: string;
	mode?: "steer" | "follow_up";
	id?: string;
}

export interface RpcGetMessageCommand {
	type: "get_message";
	id?: string;
}

export interface RpcClearCommand {
	type: "clear";
	id?: string;
}

export interface RpcAbortCommand {
	type: "abort";
	id?: string;
}

export interface RpcSubscribeCommand {
	type: "subscribe";
	event: "turn_end";
	id?: string;
}

export interface RpcStatusCommand {
	type: "status";
	id?: string;
}

export type RpcCommand =
	| RpcSendCommand
	| RpcGetMessageCommand
	| RpcClearCommand
	| RpcAbortCommand
	| RpcSubscribeCommand
	| RpcStatusCommand;

export function parseCommand(line: string): { command?: RpcCommand; error?: string } {
	try {
		const parsed = JSON.parse(line) as RpcCommand;
		if (!parsed || typeof parsed !== "object") {
			return { error: "Invalid command" };
		}
		if (typeof parsed.type !== "string") {
			return { error: "Missing command type" };
		}
		return { command: parsed };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Failed to parse command" };
	}
}
