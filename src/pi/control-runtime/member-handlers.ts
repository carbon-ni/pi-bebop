import {
	createOnlineMemberStatus,
	type MemberStatus,
	type RpcCommand,
	type RpcInboundCommand,
} from "../../domain/index.ts";
import {
	createMemberStatusFlow,
	MemberStatusFlowError,
	type MemberStatusSurface,
} from "../../application/member-status-flow.ts";
import { createMemberStatusTransport } from "../../infra/member-status-transport.ts";
import { createMemberMessageCoordinator, sendMemberMessage } from "../../application/member-message.ts";
import { sendRpcCommand } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { enqueueMemberInboxMessage, MemberInboxMessageError } from "../../application/member-inbox-message.ts";
import { openTrustedMemberInboxStore } from "../../infra/member-inbox-store.ts";
import { submitCrewBroadcast, CrewBroadcastApplicationError } from "../../application/crew-broadcast.ts";
import type { CommandHandlerContext } from "./types.ts";
import { contextIsCompacting, memberMessageErrorCode } from "./utils.ts";
export async function handleMemberStatus(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_status" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const membership = state.membershipRuntime?.getMembership();
	if (!membership) {
		respond(false, "member_status", undefined, "not-joined");
		return;
	}
	const observedAt = new Date().toISOString();
	let status: MemberStatus;
	try {
		status = createOnlineMemberStatus({
			member: { name: membership.member.name, role: membership.member.role },
			isIdle: ctx.isIdle(),
			isCompacting: contextIsCompacting(ctx),
			hasPendingMessages: ctx.hasPendingMessages(),
			observedAt,
		});
	} catch {
		respond(false, "member_status", undefined, "invalid-status");
		return;
	}
	respond(true, "member_status", { status });
	return;
}

export async function handleMemberStatusTarget(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_status_target" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const transport = state.memberStatusTransport ?? createMemberStatusTransport(5000);
	const controller = new AbortController();
	const onDisconnect = () => controller.abort();
	socket.once("close", onDisconnect);
	socket.once("error", onDisconnect);
	const surface: MemberStatusSurface = {
		getMembership: () => state.membershipRuntime?.getMembership() ?? null,
		isTrusted: () => state.context?.isProjectTrusted?.() === true,
		isIdle: () => ctx.isIdle(),
		isCompacting: () => contextIsCompacting(ctx),
		hasPendingMessages: () => ctx.hasPendingMessages(),
		probeEndpoint: transport.probeEndpoint,
		requestStatus: transport.requestStatus,
		signal: controller.signal,
		now: () => new Date().toISOString(),
	};
	const flow = createMemberStatusFlow(surface);
	try {
		const status = await flow.queryStatus(command.target);
		respond(true, "member_status_target", { status });
	} catch (error) {
		if (error instanceof MemberStatusFlowError) respond(false, "member_status_target", undefined, error.code);
		else respond(false, "member_status_target", undefined, "transport-error");
	} finally {
		controller.abort();
	}
	return;
}

async function handleMemberMessageCommand(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_follow_up" | "member_redirect" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const membership = state.membershipRuntime?.getMembership() ?? null;
	if (!membership) {
		respond(false, command.type, undefined, "not-joined");
		return;
	}
	if (state.context?.isProjectTrusted?.() !== true) {
		respond(false, command.type, undefined, "untrusted");
		return;
	}
	const dependencies = state.memberMessageDependencies ?? {
		transport: { send: sendRpcCommand },
		resolveEndpoint: resolveMemberEndpoint,
		coordinator: createMemberMessageCoordinator(),
	};
	const controller = new AbortController();
	const onDisconnect = () => controller.abort();
	socket.once("close", onDisconnect);
	socket.once("error", onDisconnect);
	try {
		const outcome = await sendMemberMessage(
			{
				membership,
				member: command.target,
				message: command.message,
				instructions: command.instructions,
				intent: command.type === "member_redirect" ? "immediate" : "follow_up",
				signal: controller.signal,
			},
			dependencies,
		);
		respond(true, command.type, {
			member:
				outcome.target.kind === "member"
					? { name: outcome.target.name, role: outcome.target.role }
					: { name: outcome.target.guestName, role: "guest" },
			deliveryId: outcome.deliveryId,
			disposition: outcome.disposition,
		});
	} catch (error) {
		respond(false, command.type, undefined, memberMessageErrorCode(error));
	} finally {
		controller.abort();
	}
	return;
}

export async function handleMemberFollowUp(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_follow_up" }>,
): Promise<void> {
	return handleMemberMessageCommand(context, command);
}

export async function handleMemberRedirect(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_redirect" }>,
): Promise<void> {
	return handleMemberMessageCommand(context, command);
}

export async function handleMemberInboxSend(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_inbox_send" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const membership = state.membershipRuntime?.getMembership() ?? null;
	const dependencies = state.memberInboxMessageDependencies ?? {
		isProjectTrusted: () => state.context?.isProjectTrusted?.() === true,
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
	socket.once("close", onDisconnect);
	socket.once("error", onDisconnect);
	try {
		const outcome = await enqueueMemberInboxMessage(
			{
				membership: membership as never,
				member: command.target,
				message: command.message,
				instructions: command.instructions,
				now: state.now?.() ?? Date.now(),
				signal: controller.signal,
			},
			dependencies,
		);
		respond(true, command.type, {
			member: { name: outcome.target.name, role: outcome.target.role },
			itemId: outcome.itemId,
			persisted: true,
			hint: outcome.hint,
		});
	} catch (error) {
		if (error instanceof MemberInboxMessageError) respond(false, command.type, undefined, error.code);
		else if (error instanceof Error && error.name === "AbortError")
			respond(false, command.type, undefined, "aborted");
		else respond(false, command.type, undefined, "storage-failed");
	} finally {
		controller.abort();
	}
	return;
}

export async function handleCrewBroadcast(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "crew_broadcast" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	if (state.context?.isProjectTrusted?.() !== true) {
		respond(false, command.type, undefined, "untrusted-project");
		return;
	}
	const membership = state.membershipRuntime?.getMembership() ?? null;
	const dependencies = state.memberMessageDependencies ?? {
		transport: { send: sendRpcCommand },
		resolveEndpoint: resolveMemberEndpoint,
		coordinator: createMemberMessageCoordinator(),
	};
	const controller = new AbortController();
	const onDisconnect = () => controller.abort();
	socket.once("close", onDisconnect);
	socket.once("error", onDisconnect);
	try {
		const outcome = await submitCrewBroadcast(
			{
				membership: membership as never,
				message: command.message,
				instructions: command.instructions,
				signal: controller.signal,
				approvedGuests: state.approvedGuestsResolver?.(),
			},
			dependencies,
		);
		if (outcome.ok === false) {
			respond(false, command.type, undefined, outcome.code);
		} else {
			respond(true, command.type, {
				dispositions: outcome.dispositions.map((item) => ({
					member: item.recipientName,
					role: item.recipientRole,
					disposition: item.disposition,
					...(item.deliveryId === undefined ? {} : { deliveryId: item.deliveryId }),
					...(item.code === undefined ? {} : { code: item.code }),
				})),
				summary: outcome.summary,
			});
		}
	} catch (error) {
		if (error instanceof CrewBroadcastApplicationError) respond(false, command.type, undefined, error.code);
		else respond(false, command.type, undefined, "transport-error");
	} finally {
		controller.abort();
	}
	return;
}
