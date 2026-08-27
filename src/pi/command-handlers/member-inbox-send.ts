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

export async function handleMemberInboxSend(
	command: Extract<RpcInboundCommand, { type: "member_inbox_send" }>,
	context: RpcHandlerContext,
): Promise<void> {
	const membership = context.state.membershipRuntime?.getMembership() ?? null;
	const dependencies = context.state.memberInboxMessageDependencies ?? {
		isProjectTrusted: () => context.state.context?.isProjectTrusted?.() === true,
		openStore: async (options) =>
			openTrustedMemberInboxStore({
				manifestPath: options.manifestPath,
				projectRoot: options.projectRoot,
				isProjectTrusted: options.isProjectTrusted,
				member: options.member,
			}),
		hintTransport: {
			sendHint: async (endpoint: string, hintCommand: RpcCommand, options: { signal?: AbortSignal }) =>
				await sendRpcCommand(endpoint, hintCommand, { ...options, timeout: 1000 }),
		},
		resolveEndpoint: resolveMemberEndpoint,
	};
	const controller = new AbortController();
	const onDisconnect = () => controller.abort();
	context.socket.once("close", onDisconnect);
	context.socket.once("error", onDisconnect);
	try {
		const outcome = await enqueueMemberInboxMessage(
			{
				membership: membership as never,
				member: command.target,
				message: command.message,
				instructions: command.instructions,
				now: Date.now(),
				signal: controller.signal,
			},
			dependencies,
		);
		context.respond(true, command.type, {
			member: { name: outcome.target.name, role: outcome.target.role },
			itemId: outcome.itemId,
			persisted: true,
			hint: outcome.hint,
		});
	} catch (error) {
		if (error instanceof MemberInboxMessageError) context.respond(false, command.type, undefined, error.code);
		else if (error instanceof Error && error.name === "AbortError")
			context.respond(false, command.type, undefined, "aborted");
		else context.respond(false, command.type, undefined, "storage-failed");
	} finally {
		controller.abort();
	}
	return;
}
