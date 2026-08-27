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

export async function handleSend(
	command: Extract<RpcInboundCommand, { type: "send" }>,
	context: RpcHandlerContext,
): Promise<void> {
	const payload = command.payload;
	if (!isMessagePayload(payload)) {
		context.respond(false, "send", undefined, "Invalid structured message payload");
		return;
	}
	if (isInboxHint(payload)) context.state.onInboxHint?.();
	const message = renderFollowUpModelContent(payload);
	const mode = command.delivery ?? "follow_up";
	const isIdle = context.ctx.isIdle() && !context.contextIsCompacting();
	const customMessage = {
		customType: SESSION_MESSAGE_TYPE,
		content: message,
		details: { messagePayload: payload },
		display: true,
	};

	// TASK-0081: accepted Bebop model delivery (Follow-up/Redirect) wakes a
	// local blocking idle wait; the unchanged message keeps its mode/FIFO.
	context.notifyAcceptedMessage(`delivery-${context.id}`);
	if (isIdle) {
		context.pi.sendMessage(customMessage, { triggerTurn: true });
	} else {
		context.pi.sendMessage(customMessage, {
			triggerTurn: true,
			deliverAs: mode === "follow_up" ? "followUp" : "steer",
		});
	}

	const disposition = isIdle ? "direct" : mode === "follow_up" ? "queued" : "steered";
	context.respond(true, "send", { deliveryId: `delivery-${context.id}`, disposition });
	return;
}
