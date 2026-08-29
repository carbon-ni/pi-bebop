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
import type { CompactionDeliveryResult } from "../../domain/index.ts";

async function deliverModelMessage(
	context: RpcHandlerContext,
	message: unknown,
	deliveryId: string,
	isIdle: boolean,
	mode: "follow_up" | "immediate",
): Promise<CompactionDeliveryResult> {
	const options = isIdle
		? { triggerTurn: true }
		: { triggerTurn: true, deliverAs: mode === "follow_up" ? "followUp" : "steer" };
	if (!context.state.modelDelivery) return { disposition: "invalid" };
	const result = await context.state.modelDelivery.sendDurably(message, options);
	if (result.disposition === "direct") context.notifyAcceptedMessage(deliveryId);
	return result;
}

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
	const disposition = isIdle ? "direct" : mode === "follow_up" ? "queued" : "steered";
	const deliveryId = `delivery-${context.id}`;
	const customMessage = {
		customType: SESSION_MESSAGE_TYPE,
		content: message,
		// TASK-0139: a busy-target queued Follow-up seeds its structured delivery
		// ID so the message_end handoff seam can attach immutable queue provenance;
		details: {
			messagePayload: payload,
			...(disposition === "queued" ? { deliveryId } : {}),
		},
		display: true,
	};
	// TASK-0081: wake only after the gate hands the unchanged message to Pi.
	const delivery = await deliverModelMessage(context, customMessage, deliveryId, isIdle, mode);
	if (delivery.disposition === "invalid" || delivery.disposition === "capacity-exceeded") {
		context.respond(false, "send", undefined, "delivery-failed");
		return;
	}
	if (disposition === "queued") context.state.queuedFollowUps.record(deliveryId);
	context.respond(true, "send", { deliveryId, disposition });
	return;
}
