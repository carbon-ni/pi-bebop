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

export async function handleMemberIdleWait(
	command: Extract<RpcInboundCommand, { type: "member_idle_wait" }>,
	context: RpcHandlerContext,
): Promise<void> {
	const membership = context.state.membershipRuntime?.getMembership();
	if (!membership) {
		context.respond(false, "member_idle_wait", undefined, "not-joined");
		return;
	}
	const ownName = membership.member.name;
	const activeTargets = new Set(context.state.idleWaitSubscriptions.map((sub) => ownName));
	const gate = tryAcquireIdleWaitSubscription(activeTargets, ownName, context.state.idleWaitSubscriptions.length);
	if (gate.ok === false) {
		context.respond(false, "member_idle_wait", undefined, gate.code);
		return;
	}
	const subscriptionId = String(context.id);
	if (context.ctx.isIdle() && !context.contextIsCompacting()) {
		// Already fully idle: complete directly without registering a lingering subscription.
		const observedAt = new Date().toISOString();
		const result = createMemberIdleWaitResult(
			{ name: membership.member.name, role: membership.member.role },
			{ outcome: "idle", disposition: "already-idle" },
			observedAt,
		);
		context.respond(true, "member_idle_wait", { subscriptionId, event: "member_idle" });
		writeMemberIdleWaitEvent(context.socket, { subscriptionId, result });
		return;
	}
	context.state.idleWaitSubscriptions.push({ socket: context.socket, subscriptionId });
	const cleanup = () => {
		const idx = context.state.idleWaitSubscriptions.findIndex((sub) => sub.subscriptionId === subscriptionId);
		if (idx !== -1) context.state.idleWaitSubscriptions.splice(idx, 1);
	};
	context.socket.once("close", cleanup);
	context.socket.once("error", cleanup);
	context.respond(true, "member_idle_wait", { subscriptionId, event: "member_idle" });
	return;
}
