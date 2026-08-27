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

export async function handleMemberStatus(
	command: Extract<RpcInboundCommand, { type: "member_status" }>,
	context: RpcHandlerContext,
): Promise<void> {
	const membership = context.state.membershipRuntime?.getMembership();
	if (!membership) {
		context.respond(false, "member_status", undefined, "not-joined");
		return;
	}
	const observedAt = new Date().toISOString();
	let status: MemberStatus;
	try {
		status = createOnlineMemberStatus({
			member: { name: membership.member.name, role: membership.member.role },
			isIdle: context.ctx.isIdle(),
			isCompacting: context.contextIsCompacting(),
			hasPendingMessages: context.ctx.hasPendingMessages(),
			observedAt,
		});
	} catch {
		context.respond(false, "member_status", undefined, "invalid-status");
		return;
	}
	context.respond(true, "member_status", { status });
	return;
}
