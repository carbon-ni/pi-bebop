import {
	createInterruptRecoveryPayload,
	createMemberIdleWaitResult,
	getFirstEntryId,
	getLastAssistantMessage,
	isInboxHint,
	isInterruptResult,
	isMessagePayload,
	renderFollowUpModelContent,
	resolveInterruptTarget,
	SESSION_MESSAGE_TYPE,
	type MemberInterruptRequest,
	type RpcInboundCommand,
} from "../../domain/index.ts";
import { createInterruptFlow } from "../../application/interrupt-flow.ts";
import { sendRpcCommand } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import { writeMemberIdleWaitEvent, type RpcSocket } from "../../infra/rpc-server.ts";
import type { CommandHandlerContext } from "./types.ts";
import { contextIsCompacting, memberInterruptErrorCode, notifyAcceptedMessage } from "./utils.ts";
import { deriveIntrayStatus } from "./status.ts";
import { tryAcquireIdleWaitSubscription } from "../../domain/index.ts";
export async function handleMemberIdleWait(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_idle_wait" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const membership = state.membershipRuntime?.getMembership();
	if (!membership) {
		respond(false, "member_idle_wait", undefined, "not-joined");
		return;
	}
	const ownName = membership.member.name;
	const activeTargets = new Set(state.idleWaitSubscriptions.map((sub) => ownName));
	const gate = tryAcquireIdleWaitSubscription(activeTargets, ownName, state.idleWaitSubscriptions.length);
	if (gate.ok === false) {
		respond(false, "member_idle_wait", undefined, gate.code);
		return;
	}
	const subscriptionId = String(id);
	if (ctx.isIdle() && !contextIsCompacting(ctx)) {
		// Already fully idle: complete directly without registering a lingering subscription.
		const observedAt = new Date().toISOString();
		const result = createMemberIdleWaitResult(
			{ name: membership.member.name, role: membership.member.role },
			{ outcome: "idle", disposition: "already-idle" },
			observedAt,
		);
		respond(true, "member_idle_wait", { subscriptionId, event: "member_idle" });
		writeMemberIdleWaitEvent(socket, { subscriptionId, result });
		return;
	}
	state.idleWaitSubscriptions.push({ socket, subscriptionId });
	const cleanup = () => {
		const idx = state.idleWaitSubscriptions.findIndex((sub) => sub.subscriptionId === subscriptionId);
		if (idx !== -1) state.idleWaitSubscriptions.splice(idx, 1);
	};
	socket.once("close", cleanup);
	socket.once("error", cleanup);
	respond(true, "member_idle_wait", { subscriptionId, event: "member_idle" });
	return;
}

export async function handleStatus(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "status" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	respond(true, "status", {
		status: deriveIntrayStatus(Boolean(state.server), Boolean(state.membershipRuntime?.getMembership())),
	});
	return;
}

export async function handleAbort(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "abort" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	ctx.abort();
	respond(true, "abort", {});
	return;
}

export async function handleMemberInterrupt(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_interrupt" }>,
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
	const resolution = resolveInterruptTarget(membership.manifest, membership.member.name, command.target);
	if (resolution.ok === false) {
		respond(false, command.type, undefined, resolution.code);
		return;
	}
	const request: MemberInterruptRequest = {
		senderName: membership.member.name,
		targetName: resolution.target.name,
		message: command.message,
		instructions: command.instructions,
		requestedAt: state.now?.() ?? Date.now(),
	};
	try {
		const payload = createInterruptRecoveryPayload(membership.member, request);
		const endpoint = await (state.memberInterruptResolveEndpoint ?? resolveMemberEndpoint)(
			resolution.target.socketPath,
		);
		const controller = new AbortController();
		const onDisconnect = () => controller.abort();
		socket.once("close", onDisconnect);
		socket.once("error", onDisconnect);
		const removeDisconnectListeners = () => {
			const removable = socket as RpcSocket & {
				removeListener?: (event: "close" | "error", listener: () => void) => void;
			};
			removable.removeListener?.("close", onDisconnect);
			removable.removeListener?.("error", onDisconnect);
		};
		try {
			const { response } = await (state.memberInterruptSend ?? sendRpcCommand)(
				endpoint,
				{ type: "interrupt", payload },
				{ timeout: 5000, signal: controller.signal, classifyLostAck: true },
			);
			if (!response.success) {
				respond(false, command.type, undefined, response.error ?? "remote-rejected");
				return;
			}
			if (!isInterruptResult(response.data)) {
				respond(false, command.type, undefined, "invalid-ack");
				return;
			}
			respond(true, command.type, {
				member: { name: resolution.target.name, role: resolution.target.role },
				interruptId: response.data.interruptId,
				disposition: response.data.disposition,
			});
		} finally {
			controller.abort();
			removeDisconnectListeners();
		}
	} catch (error) {
		respond(false, command.type, undefined, memberInterruptErrorCode(error));
	}
	return;
}

export async function handleInterrupt(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "interrupt" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const interruptFlow = createInterruptFlow({
		isIdle: () => ctx.isIdle() && !contextIsCompacting(ctx),
		abort: () => ctx.abort(),
		sendMessage: (message, options) => pi.sendMessage(message as never, options as never),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		getEntries: () => ctx.sessionManager.getEntries() as readonly unknown[],
		now: state.now,
	});
	const result = await interruptFlow.interrupt(command.payload);
	if (result.ok === false) {
		respond(false, "interrupt", undefined, result.code);
		return;
	}
	respond(true, "interrupt", { interruptId: result.interruptId, disposition: result.disposition });
	return;
}

export async function handleSubscribe(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "subscribe" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	if (command.event === "turn_end") {
		const subscriptionId = String(id);
		state.turnEndSubscriptions.push({ socket, subscriptionId });

		const cleanup = () => {
			const idx = state.turnEndSubscriptions.findIndex((s) => s.subscriptionId === subscriptionId);
			if (idx !== -1) state.turnEndSubscriptions.splice(idx, 1);
		};
		socket.once("close", cleanup);
		socket.once("error", cleanup);

		respond(true, "subscribe", { subscriptionId, event: "turn_end" });
		return;
	}
	respond(false, "subscribe", undefined, `Unknown event type: ${command.event}`);
	return;
}

export async function handleGetMessage(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "get_message" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const message = getLastAssistantMessage(ctx.sessionManager.getBranch());
	if (!message) {
		respond(true, "get_message", { message: null });
		return;
	}
	respond(true, "get_message", { message });
	return;
}

export async function handleClear(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "clear" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	if (!ctx.isIdle() || contextIsCompacting(ctx)) {
		respond(false, "clear", undefined, "Session is busy - wait for turn to complete");
		return;
	}

	const firstEntryId = getFirstEntryId(ctx.sessionManager.getEntries());
	if (!firstEntryId) {
		respond(false, "clear", undefined, "No entries in session");
		return;
	}

	const currentLeafId = ctx.sessionManager.getLeafId();
	if (currentLeafId === firstEntryId) {
		respond(true, "clear", { cleared: true, alreadyAtRoot: true });
		return;
	}

	// Access internal session manager to rewind (type assertion to access non-readonly methods)
	try {
		const sessionManager = ctx.sessionManager as unknown as { rewindTo(id: string): void };
		sessionManager.rewindTo(firstEntryId);
		respond(true, "clear", { cleared: true, targetId: firstEntryId });
	} catch (error) {
		respond(false, "clear", undefined, error instanceof Error ? error.message : "Clear failed");
	}
	return;
}

export async function handleSend(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "send" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const payload = command.payload;
	if (!isMessagePayload(payload)) {
		respond(false, "send", undefined, "Invalid structured message payload");
		return;
	}
	if (isInboxHint(payload)) state.onInboxHint?.();
	const deliveredAt = state.now?.();
	const message = renderFollowUpModelContent(payload, deliveredAt);
	const mode = command.delivery ?? "follow_up";
	const isIdle = ctx.isIdle() && !contextIsCompacting(ctx);
	const customMessage = {
		customType: SESSION_MESSAGE_TYPE,
		content: message,
		details: { messagePayload: payload, ...(deliveredAt === undefined ? {} : { deliveredAt }) },
		display: true,
	};

	// TASK-0081: accepted Bebop model delivery (Follow-up/Redirect) wakes a
	// local blocking idle wait; the unchanged message keeps its mode/FIFO.
	notifyAcceptedMessage(state, `delivery-${id}`);
	if (isIdle) {
		pi.sendMessage(customMessage, { triggerTurn: true });
	} else {
		pi.sendMessage(customMessage, {
			triggerTurn: true,
			deliverAs: mode === "follow_up" ? "followUp" : "steer",
		});
	}

	const disposition = isIdle ? "direct" : mode === "follow_up" ? "queued" : "steered";
	respond(true, "send", { deliveryId: `delivery-${id}`, disposition });
	return;
}
