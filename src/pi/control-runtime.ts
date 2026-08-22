import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { getSocketPath } from "../infra/intray-paths.ts";
import {
	createAliasSymlink,
	ensureControlDir,
	getAliasNames,
	removeAliasesForSocket,
	removeSocket,
} from "../infra/control-store.ts";
import { getCurrentGitBranch, getGitProjectName } from "../infra/git-branch.ts";
import { isMessagePayload, renderMessagePayload } from "../domain/index.ts";
import {
	closeRpcServer,
	createRpcServer,
	writeEvent,
	writeResponse,
	type RpcServer,
	type RpcSocket,
} from "../infra/rpc-server.ts";
import { updateProcessSessionEnv } from "../infra/session-env.ts";
import {
	createProjectBranchAlias,
	createSequentialProjectBranchAlias,
	getFirstEntryId,
	getLastAssistantMessage,
	isSafeAlias,
	type RpcInboundCommand,
	SESSION_MESSAGE_TYPE,
} from "../domain/index.ts";
import type { MembershipRuntime } from "../infra/membership-runtime.ts";
import type { PresenceObserver } from "../application/presence-observer.ts";

// ============================================================================
// Subscription Management
// ============================================================================

interface TurnEndSubscription {
	socket: RpcSocket;
	subscriptionId: string;
}

export interface SocketState {
	server: RpcServer | null;
	socketPath: string | null;
	context: ExtensionContext | null;
	aliases: string[];
	aliasTimer: ReturnType<typeof setInterval> | null;
	turnEndSubscriptions: TurnEndSubscription[];
	membershipRuntime: MembershipRuntime | null;
	presenceObserver?: PresenceObserver;
}

// ============================================================================
// Utilities
// ============================================================================

const STATUS_KEY = "intray";

function getSessionAlias(ctx: ExtensionContext): string | null {
	const sessionName = ctx.sessionManager.getSessionName();
	const alias = sessionName ? sessionName.trim() : "";
	if (!alias || !isSafeAlias(alias)) return null;
	return alias;
}

async function getBranchAlias(currentAliases: string[]): Promise<string | null> {
	const [branch, project] = await Promise.all([getCurrentGitBranch(), getGitProjectName()]);
	const baseAlias = branch && project ? createProjectBranchAlias(project, branch) : null;
	if (!branch || !project || !baseAlias) return null;
	const currentAlias = currentAliases.find((alias) => alias.startsWith(`${baseAlias}-`));
	return createSequentialProjectBranchAlias(project, branch, await getAliasNames(), currentAlias);
}

async function getSessionAliases(ctx: ExtensionContext, currentAliases: string[]): Promise<string[]> {
	const aliases = [getSessionAlias(ctx), await getBranchAlias(currentAliases)].filter((alias): alias is string =>
		Boolean(alias),
	);
	return Array.from(new Set(aliases));
}

function isStaleContextError(error: unknown): boolean {
	return String(error instanceof Error ? error.message : error).includes("This extension ctx is stale");
}

const MEMBERSHIP_TOOLS = ["send_follow_up", "send_immediate"] as const;

export function activateMembershipTool(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	const additions = MEMBERSHIP_TOOLS.filter((name) => !active.includes(name));
	if (additions.length > 0) pi.setActiveTools([...active, ...additions]);
}

export function deactivateMembershipTool(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	const filtered = active.filter((name) => !MEMBERSHIP_TOOLS.some((membershipTool) => membershipTool === name));
	if (filtered.length !== active.length) pi.setActiveTools(filtered);
}

export type IntrayStatus = "stopped" | "online" | "joined";

export function deriveIntrayStatus(serverPresent: boolean, membershipActive: boolean): IntrayStatus {
	if (!serverPresent) return "stopped";
	return membershipActive ? "joined" : "online";
}

async function syncAlias(state: SocketState, ctx: ExtensionContext): Promise<void> {
	if (!state.server || !state.socketPath) return;

	try {
		const aliases = await getSessionAliases(ctx, state.aliases);
		if (aliases.length === state.aliases.length && aliases.every((alias, index) => alias === state.aliases[index]))
			return;

		const sessionId = ctx.sessionManager.getSessionId();
		await removeAliasesForSocket(state.socketPath);
		for (const alias of aliases) {
			await createAliasSymlink(sessionId, alias);
		}
		state.aliases = aliases;
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
		if (state.context === ctx) state.context = null;
	}
}

// ============================================================================
// Command Handlers
// ============================================================================

export async function handleCommand(
	pi: ExtensionAPI,
	state: SocketState,
	command: RpcInboundCommand,
	socket: RpcSocket,
): Promise<void> {
	const id = command.id;
	const respond = (success: boolean, commandName: string, data?: unknown, error?: string) => {
		if (state.context) {
			void syncAlias(state, state.context);
		}
		writeResponse(socket, { type: "response", command: commandName, success, data, error, id });
	};

	const ctx = state.context;
	if (!ctx) {
		respond(false, command.type, undefined, "Session not ready");
		return;
	}

	void syncAlias(state, ctx);

	if (command.type === "presence_hint") {
		const accepted =
			state.presenceObserver?.acceptHint({
				member: command.member,
				state: command.state,
				instanceId: command.instanceId,
			}) ?? false;
		respond(true, "presence_hint", {}, accepted ? undefined : "Presence hint ignored");
		return;
	}

	if (command.type === "status") {
		respond(true, "status", {
			status: deriveIntrayStatus(Boolean(state.server), Boolean(state.membershipRuntime?.getMembership())),
		});
		return;
	}

	// Abort
	if (command.type === "abort") {
		ctx.abort();
		respond(true, "abort", {});
		return;
	}

	// Subscribe to turn_end
	if (command.type === "subscribe") {
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

	// Get last message
	if (command.type === "get_message") {
		const message = getLastAssistantMessage(ctx.sessionManager.getBranch());
		if (!message) {
			respond(true, "get_message", { message: null });
			return;
		}
		respond(true, "get_message", { message });
		return;
	}

	// Clear session
	if (command.type === "clear") {
		if (!ctx.isIdle()) {
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

	// Send message
	if (command.type === "send") {
		const payload = command.payload;
		if (!isMessagePayload(payload)) {
			respond(false, "send", undefined, "Invalid structured message payload");
			return;
		}
		const message = renderMessagePayload(payload);
		const mode = command.delivery ?? "follow_up";
		const isIdle = ctx.isIdle();
		const customMessage = {
			customType: SESSION_MESSAGE_TYPE,
			content: message,
			details: { messagePayload: payload },
			display: true,
		};

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

	respond(false, "unsupported", undefined, "Unsupported command");
}

// ============================================================================
// Server Management
// ============================================================================

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

export function formatIntrayFooter(sessionId: string, status: IntrayStatus): string {
	return `${sessionId} ${status}`;
}

function updateStatus(ctx: ExtensionContext | null, state: SocketState, enabled = true): void {
	try {
		if (!ctx?.hasUI) return;
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		const status = deriveIntrayStatus(Boolean(state.server), Boolean(state.membershipRuntime?.getMembership()));
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatIntrayFooter(sessionId, status)));
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

export function createSocketState(): SocketState {
	return {
		server: null,
		socketPath: null,
		context: null,
		aliases: [],
		aliasTimer: null,
		turnEndSubscriptions: [],
		membershipRuntime: null,
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
