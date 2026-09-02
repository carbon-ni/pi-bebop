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
	isMessagePayload,
	isInterruptResult,
	renderMemberRequestModelContent,
	renderFollowUpModelContent,
	createInterruptRecoveryPayload,
	resolveInterruptTarget,
	type MemberInterruptRequest,
} from "../domain/index.ts";
import {
	AcceptedLocalMessageWakeGate,
	createMemberIdleWaitResult,
	createOnlineMemberStatus,
	MAX_MEMBER_IDLE_WAIT_SUBSCRIPTIONS,
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
	type RpcCommand,
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
import {
	enqueueMemberInboxMessage,
	MemberInboxMessageError,
	type MemberInboxMessageDependencies,
} from "../application/member-inbox-message.ts";
import {
	submitCrewBroadcast,
	CrewBroadcastApplicationError,
	type BroadcastStoreDependencies,
} from "../application/crew-broadcast.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { writeMemberUpdateEvent } from "../infra/rpc-server.ts";

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

/** Read the TASK-0069 Pi API without caching or inferring compaction state. */
export function contextIsCompacting(ctx: ExtensionContext): boolean {
	const candidate = ctx as ExtensionContext & { isCompacting?: () => boolean };
	return candidate.isCompacting?.() === true;
}

export const MEMBERSHIP_TOOLS = [
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"broadcast_to_crew",
	"interrupt_member",
	"get_member_status",
	"wait_for_member_idle",
	"send_member_request",
	"respond_to_member_request",
	"wait_for_request_outcome",
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

	if (command.type === "member_request") {
		const membership = state.membershipRuntime?.getMembership();
		const flow = state.memberRequestFlow;
		const origin = command.payload.origin;
		if (!membership || !flow) {
			respond(false, command.type, undefined, !membership ? "not-joined" : "coordination-unavailable");
			return;
		}
		if (state.context?.isProjectTrusted?.() !== true) {
			respond(false, command.type, undefined, "untrusted");
			return;
		}
		if (!origin || origin.kind !== "crew") {
			respond(false, command.type, undefined, "invalid-payload");
			return;
		}
		const configuredOrigin = membership.manifest.members.find(
			(member) => member.name === origin.name && member.role === origin.role,
		);
		if (!configuredOrigin || configuredOrigin.name === membership.member.name) {
			respond(false, command.type, undefined, "invalid-origin");
			return;
		}
		try {
			flow.registerInboundRequest({
				requestId: command.requestId,
				requester: { name: origin.name, role: origin.role },
				message: command.payload.content,
				instructions: command.payload.instructions ?? [],
				channel: {
					send: async (update) => writeMemberUpdateEvent(socket, update),
					close: () => undefined,
				},
			});
			const cleanupInbound = () => {
				flow.removeInboundRequest(command.requestId);
			};
			socket.once("close", cleanupInbound);
			socket.once("error", cleanupInbound);
			// Registration precedes Pi visibility. Once sendMessage accepts the
			// request into context, arm idle handling and acknowledge delivery.
			// TASK-0081: accepted Bebop model delivery wakes a local blocking idle wait.
			const message = renderMemberRequestModelContent(command.payload, command.requestId);
			notifyAcceptedMessage(state, command.requestId);
			pi.sendMessage(
				{
					customType: SESSION_MESSAGE_TYPE,
					content: message,
					details: { messagePayload: command.payload, crewRequestId: command.requestId },
					display: true,
				},
				{ triggerTurn: true },
			);
			flow.acceptInboundRequest(command.requestId);
			respond(true, command.type, {
				accepted: true,
				requestId: command.requestId,
				member: { name: membership.member.name, role: membership.member.role },
			});
		} catch (error) {
			flow.registry.failBeforeAcceptance(command.requestId);
			respond(false, command.type, undefined, error instanceof Error ? error.message : "delivery-failed");
		}
		return;
	}

	if (command.type === "member_response") {
		const membership = state.membershipRuntime?.getMembership();
		const flow = state.memberRequestFlow;
		if (!membership || !flow) {
			respond(false, command.type, undefined, !membership ? "not-joined" : "no-pending-request");
			return;
		}
		try {
			await flow.respondToMemberRequest({
				message: command.message,
				instructions: command.instructions,
				requestId: command.requestId,
				member: { name: membership.member.name, role: membership.member.role },
			});
			respond(true, command.type, {});
		} catch (error) {
			respond(false, command.type, undefined, error instanceof Error ? error.message : "response-failed");
		}
		return;
	}

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

	// Member status (read-only snapshot, TASK-0047). Computes activity/pending
	// at request time and responds without triggering any turn.
	if (command.type === "member_status") {
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

	// Durable Inbox enqueue (TASK-0064): source membership/trust and trusted
	// store paths come only from this active runtime; the CLI supplies no
	// manifest, socket, source, origin, or reply metadata.
	if (command.type === "member_inbox_send") {
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
					now: Date.now(),
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

	// Durable broadcast fan-out (TASK-0064): the existing application flow
	// fixes broadcast and recipient ids before writes, persists in manifest
	// order, and reports every recipient disposition without rollback claims.
	if (command.type === "crew_broadcast") {
		const membership = state.membershipRuntime?.getMembership() ?? null;
		const dependencies = state.broadcastStoreDependencies ?? {
			isProjectTrusted: () => state.context?.isProjectTrusted?.() === true,
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
		socket.once("close", onDisconnect);
		socket.once("error", onDisconnect);
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
				respond(false, command.type, undefined, outcome.code);
			} else {
				respond(true, command.type, {
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
			if (error instanceof CrewBroadcastApplicationError) respond(false, command.type, undefined, error.code);
			else respond(false, command.type, undefined, "storage-failed");
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

	// Delegated hard recovery (CLI -> source session -> target, TASK-0065).
	if (command.type === "member_interrupt") {
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
			requestedAt: Date.now(),
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
			const remoteCode = error instanceof Error ? /^remote-error:\s*(\S+)$/.exec(error.message)?.[1] : undefined;
			const targetCode = new Set([
				"invalid-payload",
				"already-pending",
				"abort-failed",
				"no-context",
				"handoff-failed",
				"aborted",
			]);
			const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
			const code =
				error instanceof Error && error.name === "AbortError"
					? "aborted"
					: remoteCode !== undefined && targetCode.has(remoteCode)
						? remoteCode
						: error instanceof Error && "code" in error && error.code === "outcome-unknown"
							? "outcome-unknown"
							: systemCode === "ENOENT" || systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN"
								? "offline"
								: error instanceof Error && /timed? ?out|timeout/i.test(error.message)
									? "timeout"
									: "transport-error";
			respond(false, command.type, undefined, code);
		}
		return;
	}

	// Interrupt (target-owned recovery flow, TASK-0045)
	if (command.type === "interrupt") {
		const interruptFlow = createInterruptFlow({
			isIdle: () => ctx.isIdle() && !contextIsCompacting(ctx),
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

	// Send message
	if (command.type === "send") {
		const payload = command.payload;
		if (!isMessagePayload(payload)) {
			respond(false, "send", undefined, "Invalid structured message payload");
			return;
		}
		if (isInboxHint(payload)) state.onInboxHint?.();
		const message = renderFollowUpModelContent(payload);
		const mode = command.delivery ?? "follow_up";
		const isIdle = ctx.isIdle() && !contextIsCompacting(ctx);
		const customMessage = {
			customType: SESSION_MESSAGE_TYPE,
			content: message,
			details: { messagePayload: payload },
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
		wakeGate: new AcceptedLocalMessageWakeGate(),
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
 * TASK-0081 composition helper: every Bebop-owned model-bound delivery calls
 * this after protocol acceptance and BEFORE `pi.sendMessage`. An armed
 * blocking-idle-wait listener claims `message-received` (cancelling the remote
 * idle subscription) and the unchanged message keeps its original
 * Follow-up/Redirect mode and FIFO position. Redirect is a wake but not FIFO.
 * A Response arriving on its request-scoped RPC channel is not a wake.
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
