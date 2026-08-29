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

export async function handleInterrupt(
	command: Extract<RpcInboundCommand, { type: "interrupt" }>,
	context: RpcHandlerContext,
): Promise<void> {
	const interruptFlow = createInterruptFlow({
		isIdle: () => context.ctx.isIdle() && !context.contextIsCompacting(),
		abort: () => context.ctx.abort(),
		sendMessage: (message, options) => {
			if (!context.state.modelDelivery) return Promise.reject(new Error("delivery-unavailable"));
			return context.state.modelDelivery
				.sendAndWait(message, options as Readonly<Record<string, unknown>>)
				.then(() => undefined);
		},
		appendEntry: (customType, data) => context.pi.appendEntry(customType, data),
		getEntries: () => context.ctx.sessionManager.getEntries() as readonly unknown[],
	});
	const result = await interruptFlow.interrupt(command.payload);
	if (result.ok === false) {
		context.respond(false, "interrupt", undefined, result.code);
		return;
	}
	context.respond(true, "interrupt", { interruptId: result.interruptId, disposition: result.disposition });
	return;
}
