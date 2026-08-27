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

export async function handleCrewBroadcast(
	command: Extract<RpcInboundCommand, { type: "crew_broadcast" }>,
	context: RpcHandlerContext,
): Promise<void> {
	const membership = context.state.membershipRuntime?.getMembership() ?? null;
	const dependencies = context.state.broadcastStoreDependencies ?? {
		isProjectTrusted: () => context.state.context?.isProjectTrusted?.() === true,
		openStore: async (options) =>
			openTrustedMemberInboxStore({
				manifestPath: options.manifestPath,
				projectRoot: options.projectRoot,
				isProjectTrusted: options.isProjectTrusted,
				member: options.member,
			}),
	};
	const controller = new AbortController();
	const onDisconnect = () => controller.abort();
	context.socket.once("close", onDisconnect);
	context.socket.once("error", onDisconnect);
	try {
		const outcome = await submitCrewBroadcast(
			{
				membership: membership as never,
				message: command.message,
				instructions: command.instructions,
				now: Date.now(),
				signal: controller.signal,
			},
			dependencies,
		);
		if (outcome.ok === false) {
			context.respond(false, command.type, undefined, outcome.code);
		} else {
			context.respond(true, command.type, {
				broadcastId: outcome.broadcastId,
				dispositions: outcome.dispositions.map((item) => ({
					member: item.recipientName,
					role: item.recipientRole,
					itemId: item.itemId,
					disposition: item.status,
					...(item.code === undefined ? {} : { code: item.code }),
				})),
				summary: outcome.summary,
			});
		}
	} catch (error) {
		if (error instanceof CrewBroadcastApplicationError) context.respond(false, command.type, undefined, error.code);
		else context.respond(false, command.type, undefined, "storage-failed");
	} finally {
		controller.abort();
	}
	return;
}
