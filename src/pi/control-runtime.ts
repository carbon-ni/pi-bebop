import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { getSocketPath } from "../infra/intray-paths.ts";
import { ensureControlDir, removeAliasesForSocket, removeSocket } from "../infra/control-store.ts";
import { closeRpcServer, createRpcServer, writeEvent, writeMemberIdleWaitEvent } from "../infra/rpc-server.ts";
import { updateProcessSessionEnv } from "../infra/session-env.ts";
import { AcceptedLocalMessageWakeGate, createMemberIdleWaitResult, getLastAssistantMessage } from "../domain/index.ts";
import type { Membership } from "../infra/membership-runtime.ts";
import type { RpcServer } from "../infra/rpc-server.ts";
import type { SocketState } from "./control-runtime/types.ts";
import { contextIsCompacting, isStaleContextError } from "./control-runtime/utils.ts";
import { deriveIntrayStatus, type IntrayStatus } from "./control-runtime/status.ts";
import { syncAlias } from "./control-runtime/aliases.ts";
import { handleCommand } from "./control-runtime/dispatch.ts";

// Focused modules preserve the original control-runtime public surface.
export type { SocketState, CommandHandlerContext } from "./control-runtime/types.ts";
export {
	MEMBERSHIP_TOOLS,
	activateMembershipTool,
	deactivateMembershipTool,
	reconcileMembershipTools,
} from "./control-runtime/membership-tools.ts";
export { contextIsCompacting, notifyAcceptedMessage } from "./control-runtime/utils.ts";
export { deriveIntrayStatus } from "./control-runtime/status.ts";
export type { IntrayStatus } from "./control-runtime/status.ts";
export { handleCommand } from "./control-runtime/dispatch.ts";
export * from "./control-runtime/member-request-handlers.ts";
export * from "./control-runtime/guest-handlers.ts";
export * from "./control-runtime/member-handlers.ts";
export * from "./control-runtime/system-handlers.ts";

const STATUS_KEY = "pi-bebop";

async function startControlServer(pi: ExtensionAPI, state: SocketState, ctx: ExtensionContext): Promise<void> {
	await ensureControlDir();
	const sessionId = ctx.sessionManager.getSessionId();
	const socketPath = getSocketPath(sessionId);

	if (state.socketPath === socketPath && state.server) {
		state.context = ctx;
		await syncAlias(state, ctx);
		return;
	}

	await stopControlServer(state);
	await removeSocket(socketPath);

	state.context = ctx;
	state.socketPath = socketPath;
	state.server = await createRpcServer(socketPath, (command, socket) => handleCommand(pi, state, command, socket));
	state.aliases = [];
	await syncAlias(state, ctx);
}

async function stopControlServer(state: SocketState): Promise<void> {
	if (!state.server) {
		await removeAliasesForSocket(state.socketPath);
		await removeSocket(state.socketPath);
		state.socketPath = null;
		state.aliases = [];
		state.context = null;
		return;
	}

	const socketPath = state.socketPath;
	state.socketPath = null;
	state.turnEndSubscriptions = [];
	state.idleWaitSubscriptions = [];
	await closeRpcServer(state.server);
	state.server = null;
	await removeAliasesForSocket(socketPath);
	await removeSocket(socketPath);
	state.aliases = [];
	state.context = null;
}

function startAliasTimer(state: SocketState): void {
	if (state.aliasTimer) return;
	state.aliasTimer = setInterval(() => {
		if (!state.context) return;
		void syncAlias(state, state.context);
	}, 1000);
}

function stopAliasTimer(state: SocketState): void {
	if (!state.aliasTimer) return;
	clearInterval(state.aliasTimer);
	state.aliasTimer = null;
}

export async function ensureControlServer(pi: ExtensionAPI, state: SocketState, ctx: ExtensionContext): Promise<void> {
	await startControlServer(pi, state, ctx);
	startAliasTimer(state);
	updateSessionEnv(ctx, true);
	refreshIntrayStatus(state, ctx);
}

export async function enableControlServer(pi: ExtensionAPI, state: SocketState, ctx: ExtensionContext): Promise<void> {
	await ensureControlServer(pi, state, ctx);
}

export async function disableControlServer(
	state: SocketState,
	ctx: ExtensionContext | null,
	pi?: ExtensionAPI,
): Promise<void> {
	stopAliasTimer(state);
	updateStatus(ctx, state, false);
	updateSessionEnv(ctx, false);
	await stopControlServer(state);
}

export function refreshIntrayStatus(state: SocketState, ctx: ExtensionContext | null = state.context): void {
	updateStatus(ctx, state);
}

export function formatIntrayFooter(status: IntrayStatus, member?: Pick<Membership["member"], "name" | "role">): string {
	const identity = status === "joined" && member ? ` ${member.name} (${member.role})` : "";
	return `${status}${identity}`;
}

function updateStatus(ctx: ExtensionContext | null, state: SocketState, enabled = true): void {
	try {
		if (!ctx?.hasUI) return;
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const membership = state.membershipRuntime?.getMembership();
		const status = deriveIntrayStatus(Boolean(state.server), Boolean(membership));
		if (status === "stopped") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatIntrayFooter(status, membership?.member)));
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
	}
}

function updateSessionEnv(ctx: ExtensionContext | null, enabled: boolean): void {
	try {
		updateProcessSessionEnv(enabled, ctx?.sessionManager.getSessionId());
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
	}
}

export function createSocketState(now?: () => number): SocketState {
	return {
		server: null,
		socketPath: null,
		context: null,
		aliases: [],
		aliasTimer: null,
		turnEndSubscriptions: [],
		idleWaitSubscriptions: [],
		wakeGate: new AcceptedLocalMessageWakeGate(),
		membershipRuntime: null,
		guestMembershipRuntime: undefined,
		guestAdmissionRuntime: undefined,
		now,
	};
}

export function emitTurnEnd(state: SocketState, event: TurnEndEvent, ctx: ExtensionContext): void {
	if (state.turnEndSubscriptions.length === 0) return;

	void syncAlias(state, ctx);
	const lastMessage = getLastAssistantMessage(ctx.sessionManager.getBranch());
	const eventData = { message: lastMessage, turnIndex: event.turnIndex };

	const subscriptions = [...state.turnEndSubscriptions];
	state.turnEndSubscriptions = [];

	for (const sub of subscriptions) {
		writeEvent(sub.socket, {
			type: "event",
			event: "turn_end",
			data: eventData,
			subscriptionId: sub.subscriptionId,
		});
	}
}

/** Emit the one-shot idle terminal event after Pi reports a fully settled agent. */
export function emitIdleSettled(state: SocketState, ctx?: ExtensionContext): void {
	if (ctx && (!ctx.isIdle() || contextIsCompacting(ctx))) return;
	if (state.memberRequestFlow)
		setImmediate(() => {
			void state.memberRequestFlow?.settleAllInboundIdle();
		});
	if (state.idleWaitSubscriptions.length === 0) return;
	const membership = state.membershipRuntime?.getMembership();
	if (!membership) {
		state.idleWaitSubscriptions = [];
		return;
	}
	if (ctx) void syncAlias(state, ctx);
	const observedAt = new Date().toISOString();
	const result = createMemberIdleWaitResult(
		{ name: membership.member.name, role: membership.member.role },
		{ outcome: "idle", disposition: "became-idle" },
		observedAt,
	);
	const subscriptions = [...state.idleWaitSubscriptions];
	state.idleWaitSubscriptions = [];
	for (const sub of subscriptions) {
		try {
			writeMemberIdleWaitEvent(sub.socket, { subscriptionId: sub.subscriptionId, result });
		} catch {
			/* Socket may be closed. */
		}
	}
}
