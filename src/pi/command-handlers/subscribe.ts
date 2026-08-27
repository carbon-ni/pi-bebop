import {
	isMessagePayload,
	isInterruptResult,
	renderMemberRequestModelContent,
	renderFollowUpModelContent,
	createInterruptRecoveryPayload,
	resolveInterruptTarget,
	createMemberIdleWaitResult,
	tryAcquireIdleWaitSubscription,
	createOnlineMemberStatus,
	getLastAssistantMessage,
	getFirstEntryId,
	isInboxHint,
	SESSION_MESSAGE_TYPE,
	type MemberStatus,
	type MemberInterruptRequest,
	type RpcCommand,
	type RpcInboundCommand,
} from "../../domain/index.ts";
import { createInterruptFlow } from "../../application/interrupt-flow.ts";
import {
	createMemberStatusFlow,
	MemberStatusFlowError,
	type MemberStatusSurface,
} from "../../application/member-status-flow.ts";
import { createMemberStatusTransport } from "../../infra/member-status-transport.ts";
import {
	createMemberMessageCoordinator,
	sendMemberMessage,
	MemberMessageError,
} from "../../application/member-message.ts";
import { sendRpcCommand } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { enqueueMemberInboxMessage, MemberInboxMessageError } from "../../application/member-inbox-message.ts";
import { submitCrewBroadcast, CrewBroadcastApplicationError } from "../../application/crew-broadcast.ts";
import { openTrustedMemberInboxStore } from "../../infra/member-inbox-store.ts";
import { writeMemberIdleWaitEvent, writeMemberUpdateEvent, type RpcSocket } from "../../infra/rpc-server.ts";
import type { RpcHandlerContext } from "./types.ts";

export async function handleSubscribe(
	command: Extract<RpcInboundCommand, { type: "subscribe" }>,
	context: RpcHandlerContext,
): Promise<void> {
	if (command.event === "turn_end") {
		const subscriptionId = String(context.id);
		context.state.turnEndSubscriptions.push({ socket: context.socket, subscriptionId });

		const cleanup = () => {
			const idx = context.state.turnEndSubscriptions.findIndex((s) => s.subscriptionId === subscriptionId);
			if (idx !== -1) context.state.turnEndSubscriptions.splice(idx, 1);
		};
		context.socket.once("close", cleanup);
		context.socket.once("error", cleanup);

		context.respond(true, "subscribe", { subscriptionId, event: "turn_end" });
		return;
	}
	context.respond(false, "subscribe", undefined, `Unknown event type: ${command.event}`);
	return;
}
