import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RpcInboundCommand } from "../../domain/index.ts";
import { writeResponse } from "../../infra/rpc-server.ts";
import type { RpcSocket } from "../../infra/rpc-server.ts";
import type { CommandHandlerContext, CommandHandlers, SocketState } from "./types.ts";
import { syncAlias } from "./aliases.ts";
import {
	handleMemberRequest,
	handleMemberRequestStart,
	handleMemberRequestList,
	handleMemberRequestWait,
	handleMemberResponse,
} from "./member-request-handlers.ts";
import { handleGuestJoin, handleGuestSend, handleGuestLeave, handlePresenceHint } from "./guest-handlers.ts";
import {
	handleMemberStatus,
	handleMemberStatusTarget,
	handleMemberFollowUp,
	handleMemberRedirect,
	handleMemberInboxSend,
	handleCrewBroadcast,
} from "./member-handlers.ts";
import {
	handleMemberIdleWait,
	handleStatus,
	handleAbort,
	handleMemberInterrupt,
	handleInterrupt,
	handleSubscribe,
	handleGetMessage,
	handleClear,
	handleSend,
} from "./system-handlers.ts";

const COMMAND_HANDLERS: CommandHandlers = {
	member_request: handleMemberRequest,
	member_request_start: handleMemberRequestStart,
	member_request_list: handleMemberRequestList,
	member_request_wait: handleMemberRequestWait,
	member_response: handleMemberResponse,
	guest_join: handleGuestJoin,
	guest_leave: handleGuestLeave,
	guest_send: handleGuestSend,
	presence_hint: handlePresenceHint,
	member_status: handleMemberStatus,
	member_status_target: handleMemberStatusTarget,
	member_follow_up: handleMemberFollowUp,
	member_redirect: handleMemberRedirect,
	member_inbox_send: handleMemberInboxSend,
	crew_broadcast: handleCrewBroadcast,
	member_idle_wait: handleMemberIdleWait,
	status: handleStatus,
	abort: handleAbort,
	member_interrupt: handleMemberInterrupt,
	interrupt: handleInterrupt,
	subscribe: handleSubscribe,
	get_message: handleGetMessage,
	clear: handleClear,
	send: handleSend,
};

function createCommandResponder(
	state: SocketState,
	socket: RpcSocket,
	id: RpcInboundCommand["id"],
): CommandHandlerContext["respond"] {
	return (success, commandName, data, error) => {
		if (state.context) void syncAlias(state, state.context);
		writeResponse(socket, { type: "response", command: commandName, success, data, error, id });
	};
}

export async function handleCommand(
	pi: ExtensionAPI,
	state: SocketState,
	command: RpcInboundCommand,
	socket: RpcSocket,
): Promise<void> {
	const respond = createCommandResponder(state, socket, command.id);
	const ctx = state.context;
	if (!ctx) {
		respond(false, command.type, undefined, "Session not ready");
		return;
	}
	void syncAlias(state, ctx);
	const handler = COMMAND_HANDLERS[command.type];
	if (handler) await handler({ pi, state, ctx, socket, respond, id: command.id }, command as never);
	else respond(false, "unsupported", undefined, "Unsupported command");
}
