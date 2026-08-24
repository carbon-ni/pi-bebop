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
	createMemberIdleWaitResult,
	createOnlineMemberStatus,
	MAX_MEMBER_IDLE_WAIT_SUBSCRIPTIONS,
	restoreMemberFocus,
	tryAcquireIdleWaitSubscription,
	type MemberStatus,
} from "../domain/index.ts";
import {
	closeRpcServer,
	createRpcServer,
	writeEvent,
	writeMemberIdleWaitEvent,
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
	isInboxHint,
	isSafeAlias,
	type RpcInboundCommand,
	SESSION_MESSAGE_TYPE,
} from "../domain/index.ts";
import type { MembershipRuntime } from "../infra/membership-runtime.ts";
import type { PresenceObserver } from "../application/presence-observer.ts";
import { createInterruptFlow } from "../application/interrupt-flow.ts";
import {
	createMemberStatusFlow,
	MemberStatusFlowError,
	type MemberStatusSurface,
} from "../application/member-status-flow.ts";
import { createMemberStatusTransport, type MemberStatusTransport } from "../infra/member-status-transport.ts";
import {
	createMemberMessageCoordinator,
	sendMemberMessage,
	MemberMessageError,
	type MemberMessageDependencies,
} from "../application/member-message.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";

// ============================================================================
// Subscription Management
// ============================================================================

interface TurnEndSubscription {
	socket: RpcSocket;
	subscriptionId: string;
}

interface IdleWaitSubscription {
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
	idleWaitSubscriptions: IdleWaitSubscription[];
	membershipRuntime: MembershipRuntime | null;
	presenceObserver?: PresenceObserver;
	onInboxHint?: () => void;
	/** Injectable member-status transport (TASK-0061); defaults to the shared real transport. */
	memberStatusTransport?: MemberStatusTransport;
	/** Injectable member-message transport/coordinator (TASK-0062); defaults to the shared real dependencies. */
	memberMessageDependencies?: MemberMessageDependencies;
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

export const MEMBERSHIP_TOOLS = [
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"broadcast_to_crew",
	"interrupt_member",
	"get_member_status",
	"update_member_focus",
	"wait_for_member_idle",
] as const;

/**
 * Joined active set is the full post-0045 public surface: all five membership
 * tools, `interrupt_member` included (it is a shipped public tool, not a
 * hidden surface). Registered set and joined active set are identical.
 */
export function activateMembershipTool(pi: ExtensionAPI): void {
	reconcileMembershipTools(pi, true);
}

export function deactivateMembershipTool(pi: ExtensionAPI): void {
	reconcileMembershipTools(pi, false);
}

/**
 * Deterministically reconcile the active tool set against membership.
 *
 * Membership tools stay registered (getAllTools) but must not appear in the
 * provider-active schema (getActiveTools) while unjoined. Pi auto-activates
 * newly registered extension tools, so unjoined lifecycles (fresh load, new
 * unjoined session, server-only startup, restore failure) must explicitly
 * remove them, while join/restore adds them back. Unrelated tools are
 * preserved in order and membership; the call is idempotent.
 */
export function reconcileMembershipTools(pi: ExtensionAPI, active: boolean): void {
	const current = pi.getActiveTools();
	const withoutMembership = current.filter(
		(name) => !MEMBERSHIP_TOOLS.some((membershipTool) => membershipTool === name),
	);
	const next = active ? [...withoutMembership, ...MEMBERSHIP_TOOLS] : withoutMembership;
	if (next.length === current.length && next.every((name, index) => name === current[index])) return;
	pi.setActiveTools(next);
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
		respond(true, "presence_hint", { accepted });
		return;
	}

	// Member status (read-only snapshot, TASK-0047). Computes activity/pending/focus
	// at request time and responds without triggering any turn.
	if (command.type === "member_status") {
		const membership = state.membershipRuntime?.getMembership();
		if (!membership) {
			respond(false, "member_status", undefined, "not-joined");
			return;
		}
		const focus = restoreMemberFocus(ctx.sessionManager.getEntries(), membership.member.socketPath);
		const observedAt = new Date().toISOString();
		let status: MemberStatus;
		try {
			status = createOnlineMemberStatus({
				member: { name: membership.member.name, role: membership.member.role },
				isIdle: ctx.isIdle(),
				hasPendingMessages: ctx.hasPendingMessages(),
				focus,
				observedAt,
			});
		} catch {
			respond(false, "member_status", undefined, "invalid-status");
			return;
		}
		respond(true, "member_status", { status });
		return;
	}

	// Delegated member status (TASK-0061): a CLI asks this joined session for
	// the status of a TARGET member. The session derives membership/trust from
	// its own active runtime (never from request fields) and runs the same
	// member-status flow/dependencies as the in-agent tool, so target
	// resolution and privacy validation are never copied into the CLI. The
	// CLI path uses a fixed 5s target probe, and the CLI's disconnect aborts
	// the in-flight probe/RPC so a cancelled CLI cannot continue target IO.
	if (command.type === "member_status_target") {
		const transport = state.memberStatusTransport ?? createMemberStatusTransport(5000);
		const controller = new AbortController();
		const onDisconnect = () => controller.abort();
		socket.once("close", onDisconnect);
		socket.once("error", onDisconnect);
		const surface: MemberStatusSurface = {
			getMembership: () => state.membershipRuntime?.getMembership() ?? null,
			isTrusted: () => state.context?.isProjectTrusted?.() === true,
			isIdle: () => ctx.isIdle(),
			hasPendingMessages: () => ctx.hasPendingMessages(),
			getEntries: () => ctx.sessionManager.getEntries(),
			appendEntry: () => undefined,
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

	// Delegated message delivery (TASK-0062): a CLI asks this joined session to
	// deliver a follow-up or redirect to a TARGET member. The session derives
	// membership/trust from its own active runtime (never from request fields)
	// and runs the SAME member-message application operation the in-agent tools
	// use, with delivery intent from the command type. Accepted-delivery only:
	// the acknowledgement carries resolved identity, deliveryId, and
	// disposition; no response correlation is invented. The CLI's disconnect
	// aborts the in-flight transport so a cancelled CLI cannot continue target IO.
	if (command.type === "member_follow_up" || command.type === "member_redirect") {
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
				member: { name: outcome.target.name, role: outcome.target.role },
				deliveryId: outcome.deliveryId,
				disposition: outcome.disposition,
			});
		} catch (error) {
			if (error instanceof MemberMessageError) respond(false, command.type, undefined, error.code);
			else if (error instanceof Error && error.name === "AbortError")
				respond(false, command.type, undefined, "aborted");
			else if (error instanceof Error && "code" in error && error.code === "outcome-unknown")
				respond(false, command.type, undefined, "outcome-unknown");
			else {
				const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
				if (systemCode === "ENOENT" || systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN")
					respond(false, command.type, undefined, "offline");
				else if (error instanceof Error && /timed? ?out|timeout/i.test(error.message))
					respond(false, command.type, undefined, "timeout");
				else respond(false, command.type, undefined, "transport-error");
			}
		} finally {
			controller.abort();
		}
		return;
	}

	// One-shot member idle wait (TASK-0051). Registration plus the initial
	// ctx.isIdle() snapshot are atomic in this synchronous handler so an idle
	// transition cannot be lost between separate check/subscribe calls. The
	// terminal event is emitted only from Pi `agent_settled` (emitIdleSettled),
	// never from `agent_end` or `turn_end`.
	if (command.type === "member_idle_wait") {
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
		if (ctx.isIdle()) {
			// Already idle: complete directly without registering a lingering subscription.
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

	// Interrupt (target-owned recovery flow, TASK-0045)
	if (command.type === "interrupt") {
		const interruptFlow = createInterruptFlow({
			isIdle: () => ctx.isIdle(),
			abort: () => ctx.abort(),
			sendMessage: (message, options) => pi.sendMessage(message as never, options as never),
			appendEntry: (customType, data) => pi.appendEntry(customType, data),
			getEntries: () => ctx.sessionManager.getEntries() as readonly unknown[],
		});
		const result = await interruptFlow.interrupt(command.payload);
		if (result.ok === false) {
			respond(false, "interrupt", undefined, result.code);
			return;
		}
		respond(true, "interrupt", { interruptId: result.interruptId, disposition: result.disposition });
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
		if (isInboxHint(payload)) state.onInboxHint?.();
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
		idleWaitSubscriptions: [],
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

/**
 * One-shot idle terminal emission, driven ONLY by Pi `agent_settled`
 * (TASK-0051). Busy waits registered via `member_idle_wait` complete here with
 * `idle/became-idle` after all retry/compaction/queued-continuation work is
 * exhausted. Never call this from `agent_end` or `turn_end` handlers:
 * `agent_end` alone is insufficient while continuation remains. The result
 * contains only name/role, outcome/disposition, and the observation timestamp.
 */
export function emitIdleSettled(state: SocketState, ctx?: ExtensionContext): void {
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
