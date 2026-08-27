import type { RpcInboundCommand } from "../../domain/index.ts";
import type { AnyRpcCommandHandler } from "./types.ts";
import { handleMemberRequest } from "./member-request.ts";
import { handleMemberResponse } from "./member-response.ts";
import { handlePresenceHint } from "./presence-hint.ts";
import { handleMemberStatus } from "./member-status.ts";
import { handleMemberStatusTarget } from "./member-status-target.ts";
import { handleMemberFollowUp } from "./member-follow-up.ts";
import { handleMemberRedirect } from "./member-redirect.ts";
import { handleMemberInboxSend } from "./member-inbox-send.ts";
import { handleCrewBroadcast } from "./crew-broadcast.ts";
import { handleMemberIdleWait } from "./member-idle-wait.ts";
import { handleStatus } from "./status.ts";
import { handleAbort } from "./abort.ts";
import { handleMemberInterrupt } from "./member-interrupt.ts";
import { handleInterrupt } from "./interrupt.ts";
import { handleSubscribe } from "./subscribe.ts";
import { handleGetMessage } from "./get-message.ts";
import { handleClear } from "./clear.ts";
import { handleSend } from "./send.ts";

export const commandHandlers: Record<RpcInboundCommand["type"], AnyRpcCommandHandler> = {
	member_request: handleMemberRequest,
	member_response: handleMemberResponse,
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

export function getCommandHandler(type: RpcInboundCommand["type"]): AnyRpcCommandHandler | undefined {
	return commandHandlers[type];
}
