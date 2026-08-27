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

export async function handleMemberStatusTarget(
	command: Extract<RpcInboundCommand, { type: "member_status_target" }>,
	context: RpcHandlerContext,
): Promise<void> {
	const transport = context.state.memberStatusTransport ?? createMemberStatusTransport(5000);
	const controller = new AbortController();
	const onDisconnect = () => controller.abort();
	context.socket.once("close", onDisconnect);
	context.socket.once("error", onDisconnect);
	const surface: MemberStatusSurface = {
		getMembership: () => context.state.membershipRuntime?.getMembership() ?? null,
		isTrusted: () => context.state.context?.isProjectTrusted?.() === true,
		isIdle: () => context.ctx.isIdle(),
		isCompacting: () => context.contextIsCompacting(),
		hasPendingMessages: () => context.ctx.hasPendingMessages(),
		probeEndpoint: transport.probeEndpoint,
		requestStatus: transport.requestStatus,
		signal: controller.signal,
		now: () => new Date().toISOString(),
	};
	const flow = createMemberStatusFlow(surface);
	try {
		const status = await flow.queryStatus(command.target);
		context.respond(true, "member_status_target", { status });
	} catch (error) {
		if (error instanceof MemberStatusFlowError)
			context.respond(false, "member_status_target", undefined, error.code);
		else context.respond(false, "member_status_target", undefined, "transport-error");
	} finally {
		controller.abort();
	}
	return;
}
