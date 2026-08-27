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

export async function handleClear(
	command: Extract<RpcInboundCommand, { type: "clear" }>,
	context: RpcHandlerContext,
): Promise<void> {
	if (!context.ctx.isIdle() || context.contextIsCompacting()) {
		context.respond(false, "clear", undefined, "Session is busy - wait for turn to complete");
		return;
	}

	const firstEntryId = getFirstEntryId(context.ctx.sessionManager.getEntries());
	if (!firstEntryId) {
		context.respond(false, "clear", undefined, "No entries in session");
		return;
	}

	const currentLeafId = context.ctx.sessionManager.getLeafId();
	if (currentLeafId === firstEntryId) {
		context.respond(true, "clear", { cleared: true, alreadyAtRoot: true });
		return;
	}

	// Access internal session manager to rewind (type assertion to access non-readonly methods)
	try {
		const sessionManager = context.ctx.sessionManager as unknown as { rewindTo(id: string): void };
		sessionManager.rewindTo(firstEntryId);
		context.respond(true, "clear", { cleared: true, targetId: firstEntryId });
	} catch (error) {
		context.respond(false, "clear", undefined, error instanceof Error ? error.message : "Clear failed");
	}
	return;
}
