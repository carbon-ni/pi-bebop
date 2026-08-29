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
import {
	AcceptedLocalMessageWakeGate,
	createMemberIdleWaitResult,
	getLastAssistantMessage,
	QueuedFollowUpAcceptanceRegistry,
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
	isSafeAlias,
	type RpcInboundCommand,
	type RpcCommand,
} from "../domain/index.ts";
import type { Membership, MembershipRuntime } from "../infra/membership-runtime.ts";
import type { PresenceObserver } from "../application/presence-observer.ts";
import type { MemberStatusTransport } from "../infra/member-status-transport.ts";
import type { MemberMessageDependencies } from "../application/member-message.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import type { MemberInboxMessageDependencies } from "../application/member-inbox-message.ts";
import type { BroadcastStoreDependencies } from "../application/crew-broadcast.ts";
import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { getCommandHandler } from "./command-handlers/registry.ts";
import type { SessionNameController } from "./session-name.ts";

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
	/** TASK-0081: session-local accepted-message wake seam for the single blocking idle wait. */
	wakeGate: AcceptedLocalMessageWakeGate;
	/** TASK-0139: session-local busy-acceptance registry for queued Follow-up handoff provenance. */
	queuedFollowUps: QueuedFollowUpAcceptanceRegistry;
	membershipRuntime: MembershipRuntime | null;
	presenceObserver?: PresenceObserver;
	onInboxHint?: () => void;
	/** Injectable member-status transport (TASK-0061); defaults to the shared real transport. */
	memberStatusTransport?: MemberStatusTransport;
	/** Injectable member-message transport/coordinator (TASK-0062); defaults to the shared real dependencies. */
	memberMessageDependencies?: MemberMessageDependencies;
	/** Injectable durable Inbox action dependencies (TASK-0064). */
	memberInboxMessageDependencies?: MemberInboxMessageDependencies;
	/** Injectable durable broadcast action dependencies (TASK-0064). */
	broadcastStoreDependencies?: BroadcastStoreDependencies;
	/** Correlated request/update lifecycle (TASK-0071). */
	memberRequestFlow?: MemberRequestFlow;
	/** Injectable source-to-target interrupt transport for deterministic recovery tests (TASK-0065). */
	memberInterruptSend?: typeof sendRpcCommand;
	memberInterruptResolveEndpoint?: typeof resolveMemberEndpoint;
	/** Current session display-name ownership; auto Member names never publish a global alias. */
	sessionNameController?: SessionNameController;
}

// ============================================================================
// Utilities
// ============================================================================

const STATUS_KEY = "pi-bebop";

export function getSessionAlias(ctx: ExtensionContext, state: SocketState): string | null {
	if (state.sessionNameController?.isAutoOwned()) return null;
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

async function getSessionAliases(
	ctx: ExtensionContext,
	currentAliases: string[],
	state: SocketState,
): Promise<string[]> {
	const aliases = [getSessionAlias(ctx, state), await getBranchAlias(currentAliases)].filter(
		(alias): alias is string => Boolean(alias),
	);
	return Array.from(new Set(aliases));
}

function isStaleContextError(error: unknown): boolean {
	return String(error instanceof Error ? error.message : error).includes("This extension ctx is stale");
}

/** Read the TASK-0069 Pi API without caching or inferring compaction state. */
export function contextIsCompacting(ctx: ExtensionContext): boolean {
	const candidate = ctx as ExtensionContext & { isCompacting?: () => boolean };
	return candidate.isCompacting?.() === true;
}

export const MEMBERSHIP_TOOLS = [
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"send_to_crew",
	"broadcast_to_crew",
	"interrupt_member",
	"get_member_status",
	"wait_for_member_idle",
	"send_member_request",
	"respond_to_member_request",
	"wait_for_request_outcome",
	"leave_crew_post",
	"read_crew_board",
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
		const aliases = await getSessionAliases(ctx, state.aliases, state);
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
		if (state.context) void syncAlias(state, state.context);
		writeResponse(socket, { type: "response", command: commandName, success, data, error, id });
	};

	const ctx = state.context;
	if (!ctx) {
		respond(false, command.type, undefined, "Session not ready");
		return;
	}

	void syncAlias(state, ctx);
	const handler = getCommandHandler(command.type);
	if (!handler) {
		respond(false, "unsupported", undefined, "Unsupported command");
		return;
	}

	await handler(command, {
		pi,
		state,
		ctx,
		socket,
		id,
		respond,
		contextIsCompacting: () => contextIsCompacting(ctx),
		notifyAcceptedMessage: (deliveryId) => notifyAcceptedMessage(state, deliveryId),
		deriveIntrayStatus,
	});
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

export async function refreshSessionAliases(
	state: SocketState,
	ctx: ExtensionContext | null = state.context,
): Promise<void> {
	if (ctx) await syncAlias(state, ctx);
}

export function formatIntrayFooter(
	status: IntrayStatus,
	member?: Pick<Membership["member"], "name" | "role">,
	crewName?: string,
): string {
	const identity =
		status === "joined" && member
			? ` ${crewName === undefined ? "" : `${crewName} — `}${member.name} (${member.role})`
			: "";
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
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("dim", formatIntrayFooter(status, membership?.member, membership?.manifest.name)),
		);
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
		wakeGate: new AcceptedLocalMessageWakeGate(),
		queuedFollowUps: new QueuedFollowUpAcceptanceRegistry({ now: () => Date.now() }),
		membershipRuntime: null,
		sessionNameController: undefined,
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
 * TASK-0081 composition helper: every Bebop-owned model-bound delivery calls
 * this after protocol acceptance and BEFORE `pi.sendMessage`. An armed
 * blocking-idle-wait listener claims `message-received` (cancelling the remote
 * idle subscription) and the unchanged message keeps its original
 * Follow-up/Redirect mode and FIFO position. Redirect is a wake but not FIFO.
 * A Response arriving only on its request-scoped RPC channel is NOT a wake;
 * its later crew-wait-resume model delivery is.
 */
export function notifyAcceptedMessage(state: SocketState, deliveryId: string): void {
	// Null-safe: partial-state consumers (tests) without a wake gate are a no-op.
	if (!state.wakeGate) return;
	state.wakeGate.notifyAccepted(deliveryId);
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
	// agent_settled and compaction end both use this path; only the combined
	// predicate releases a waiter. `isIdle()` alone is true during manual
	// compaction, so never report availability while compaction remains active.
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
