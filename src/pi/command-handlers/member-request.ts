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

export async function handleMemberRequest(
	command: Extract<RpcInboundCommand, { type: "member_request" }>,
	context: RpcHandlerContext,
): Promise<void> {
	const membership = context.state.membershipRuntime?.getMembership();
	const flow = context.state.memberRequestFlow;
	const origin = command.payload.origin;
	if (!membership || !flow) {
		context.respond(false, command.type, undefined, !membership ? "not-joined" : "coordination-unavailable");
		return;
	}
	if (context.state.context?.isProjectTrusted?.() !== true) {
		context.respond(false, command.type, undefined, "untrusted");
		return;
	}
	if (!origin || origin.kind !== "crew") {
		context.respond(false, command.type, undefined, "invalid-payload");
		return;
	}
	const configuredOrigin = membership.manifest.members.find(
		(member) => member.name === origin.name && member.role === origin.role,
	);
	if (!configuredOrigin || configuredOrigin.name === membership.member.name) {
		context.respond(false, command.type, undefined, "invalid-origin");
		return;
	}
	try {
		flow.registerInboundRequest({
			requestId: command.requestId,
			requester: { name: origin.name, role: origin.role },
			message: command.payload.content,
			instructions: command.payload.instructions ?? [],
			channel: {
				send: async (update) => writeMemberUpdateEvent(context.socket, update),
				close: () => undefined,
			},
		});
		const cleanupInbound = () => {
			flow.removeInboundRequest(command.requestId);
		};
		context.socket.once("close", cleanupInbound);
		context.socket.once("error", cleanupInbound);
		// Registration precedes visibility. A compacting receiver keeps the live
		// channel pending until the gate hands the exact request to Pi.
		const message = renderMemberRequestModelContent(command.payload, command.requestId);
		const modelMessage = {
			customType: SESSION_MESSAGE_TYPE,
			content: message,
			details: { messagePayload: command.payload, crewRequestId: command.requestId },
			display: true,
		};
		const delivery = context.state.modelDelivery?.send(modelMessage, { triggerTurn: true });
		if (!context.state.modelDelivery) context.pi.sendMessage(modelMessage, { triggerTurn: true });
		if (!delivery || delivery.disposition === "direct") {
			context.notifyAcceptedMessage(command.requestId);
			flow.acceptInboundRequest(command.requestId);
		}
		context.respond(true, command.type, {
			accepted: true,
			requestId: command.requestId,
			member: { name: membership.member.name, role: membership.member.role },
		});
	} catch (error) {
		flow.registry.failBeforeAcceptance(command.requestId);
		context.respond(false, command.type, undefined, error instanceof Error ? error.message : "delivery-failed");
	}
	return;
}
