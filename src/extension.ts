import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { registerSessionControlCommand } from "./pi/control-commands.ts";
import {
	renderCrewPresence,
	renderCrewRosterEntry,
	renderCrewStatusEntry,
	renderCrewInboxEntry,
	renderCrewBoardEntry,
	renderSessionMessage,
	renderCrewInterrupt,
} from "./pi/message-renderer.ts";
import {
	registerSendFollowUpTool,
	registerRedirectMemberTool,
	registerSendToInboxTool,
	registerSendToCrewTool,
	registerBroadcastToCrewTool,
	registerInterruptMemberTool,
	registerGetMemberStatusTool,
	registerWaitForMemberIdleTool,
	registerWaitForCrewIdleTool,
	registerSendMemberRequestTool,
	registerRespondToMemberRequestTool,
	registerWaitForRequestOutcomeTool,
	registerLeaveCrewPostTool,
	registerReadCrewBoardTool,
} from "./tools/index.ts";
import { createMemberMessageCoordinator } from "./application/member-message.ts";
import { createCrewIdleWaitFlow } from "./application/crew-idle-wait-flow.ts";
import { createPresenceComposition } from "./pi/presence-composition.ts";
import { createPresenceObserverAdapter } from "./application/presence-adapter.ts";
import { createMemberStatusTransport } from "./infra/member-status-transport.ts";
import { createCrewIdleWaitTransport } from "./infra/crew-idle-wait-transport.ts";
import { sendMemberIdleWait, sendRpcCommand, sendMemberRequest } from "./infra/rpc-client.ts";
import { resolveMemberEndpoint } from "./infra/socket-endpoint.ts";
import { probeMemberEndpoint } from "./infra/member-endpoint.ts";
import type { MemberIdleWaitCommand } from "./domain/index.ts";
import {
	activateMembershipTool,
	createSocketState,
	deactivateMembershipTool,
	disableControlServer,
	emitIdleSettled,
	emitTurnEnd,
	ensureControlServer,
	refreshSessionAliases,
	reconcileMembershipTools,
	refreshIntrayStatus,
	notifyAcceptedMessage,
	cancelCrewMemberIdleCommand,
} from "./pi/control-runtime.ts";
import { getSocketPath } from "./infra/intray-paths.ts";
import { getCrewManifestPathFromSocketPath, readTrustedCrewManifest } from "./infra/crew-manifest-store.ts";
import { openTrustedCrewAgreementStore } from "./infra/crew-agreement-store.ts";
import { openTrustedMemberInboxStore } from "./infra/member-inbox-store.ts";
import { openTrustedCrewBoardStore } from "./infra/crew-board-store.ts";
import { activateAgreementRevision } from "./application/crew-agreement-activation.ts";
import { createMembershipRuntime } from "./infra/membership-runtime.ts";
import {
	appendMembershipContext,
	getLatestMembershipState,
	MEMBERSHIP_ENTRY_TYPE,
	membershipStateFromRuntime,
} from "./pi/membership-context.ts";
import { releaseMembershipBeforeCleanup, restorePersistedMembership } from "./pi/membership-lifecycle.ts";
import {
	maybeHandleStartupRoleJoin,
	maybeHandleStartupSocketJoin,
	resolveStartupCrewRole,
	type StartupRoleSelection,
} from "./pi/startup-send.ts";
import { createInboxBridgeController, ownershipFromMembership } from "./pi/inbox-bridge-runtime.ts";
import { createInterruptFlow } from "./application/interrupt-flow.ts";
import { SESSION_MESSAGE_TYPE } from "./domain/index.ts";
import { YieldingWaitRegistry } from "./domain/index.ts";
import { WAIT_RESUME_MESSAGE_TYPE } from "./pi/wait-resume.ts";
import { YieldingWaitRuntime } from "./pi/wait-resume.ts";
import { MemberRequestFlow } from "./application/member-request-flow.ts";
import { handleSessionStart } from "./pi/session-start.ts";
import { handleMessageEndQueuedFollowUp, queuedFollowUpMessageEndResult } from "./pi/queued-follow-up-handoff.ts";
import { createSessionNameController } from "./pi/session-name.ts";
import { reportActionableError } from "./pi/actionable-error-output.ts";
import { createModelDeliveryAdapter } from "./pi/compaction-delivery.ts";

const CREW_FLAG = "crew";
const CREW_SOCKET_FLAG = "crew-socket";
const CREW_ROLE_FLAG = "crew-role";

function reportLifecycleFailure(context: ExtensionContext | null): void {
	reportActionableError(context, {
		code: "unexpected-failure",
		operation: "Crew extension lifecycle",
		reason: "the lifecycle operation could not be completed",
		recovery: ["retry the Crew operation; if it repeats, inspect Crew state and report the code."],
	});
}

/** Crew management with its own namespaced socket transport. */
export default function (pi: ExtensionAPI) {
	pi.registerFlag(CREW_FLAG, {
		description: "Enable Bebop's crew socket server",
		type: "boolean",
	});
	pi.registerFlag(CREW_SOCKET_FLAG, {
		description: "Select a crew socket path as the current crew identity",
		type: "string",
	});
	pi.registerFlag(CREW_ROLE_FLAG, {
		description: "Select a configured crew member by exact role in the current project",
		type: "string",
	});

	pi.registerMessageRenderer(SESSION_MESSAGE_TYPE, renderSessionMessage);
	pi.registerMessageRenderer(WAIT_RESUME_MESSAGE_TYPE, renderSessionMessage);
	pi.registerMessageRenderer("crew-presence", renderCrewPresence);
	pi.registerMessageRenderer("crew-interrupt", renderCrewInterrupt);
	pi.registerEntryRenderer("crew-roster", renderCrewRosterEntry);
	pi.registerEntryRenderer("crew-status", renderCrewStatusEntry);
	pi.registerEntryRenderer("crew-inbox", renderCrewInboxEntry);
	pi.registerEntryRenderer("crew-board", renderCrewBoardEntry);

	const state = createSocketState();
	state.modelDelivery = createModelDeliveryAdapter((message, options) => pi.sendMessage(message, options));
	const sessionNameApi = pi as ExtensionAPI & {
		setSessionName?: (name: string) => void;
		getSessionName?: () => string | undefined;
	};
	const sessionNameController = createSessionNameController({
		setSessionName: (name) => sessionNameApi.setSessionName?.(name),
		getSessionName: () => sessionNameApi.getSessionName?.(),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	});
	state.sessionNameController = sessionNameController;
	state.membershipRuntime = createMembershipRuntime({
		loadManifest: async (manifestPath) => {
			const context = state.context;
			if (!context) throw new Error("Session context is not ready");
			const projectRoot = path.resolve(path.dirname(manifestPath), "..", "..");
			return readTrustedCrewManifest(manifestPath, projectRoot, () => context.isProjectTrusted());
		},
	});

	const inboxBridge = createInboxBridgeController(pi, state);
	state.onInboxHint = () => {
		void inboxBridge.attemptOffer();
	};

	const recoverInterrupts = async () => {
		const context = state.context;
		if (!context) return;
		const interruptFlow = createInterruptFlow({
			isIdle: () => context.isIdle(),
			abort: () => context.abort(),
			sendMessage: (message, options) => pi.sendMessage(message as never, options as never),
			appendEntry: (customType, data) => pi.appendEntry(customType, data),
			getEntries: () => context.sessionManager.getEntries() as readonly unknown[],
		});
		await interruptFlow.recoverPending();
	};

	state.memberRequestFlow = new MemberRequestFlow({
		transport: {
			open: (endpoint, command, options) =>
				sendMemberRequest(endpoint, command, {
					timeout: options.timeoutMs,
					signal: options.signal,
					onUpdate: options.onUpdate,
				}),
			respond: async (channel, update) => channel.send(update),
		},
		resolveEndpoint: resolveMemberEndpoint,
		// TASK-0080: at the target's first post-context idle, queue exactly one
		// best-effort reminder (structured inbound guidance with the original
		// requestId, followUp + triggerTurn, no callback route). A terminal
		// claimed before delivery makes the reminder inert: respond_to_member_request
		// rejects for the now-terminal request, so the reminder can never resolve
		// or alter the Request outcome.
		onFirstIdleReminder: (requestId, requester) => {
			state.modelDelivery?.send(
				{
					customType: "bebop-session-message",
					content: `The Member request ${requestId} from ${requester.name} (${requester.role}) is awaiting your Response. If you have the answer, reply now with respond_to_member_request; the requester waits only a short bounded grace before the request expires.`,
					details: { crewRequestId: requestId, requestId },
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});
	// TASK-0077: one shared pending-wait registry + resume delivery for the
	// yielding coordination waits. The registry survives the run; a terminal
	// lifecycle delivery resolves the oldest matching parked wait exactly once
	// and emits one crew-wait-resume message that wakes the agent later.
	const yieldRuntime = new YieldingWaitRuntime({
		registry: new YieldingWaitRegistry(),
		deliver: (message) => {
			const isIdle = state.context?.isIdle?.() === true;
			const customMessage = {
				customType: WAIT_RESUME_MESSAGE_TYPE,
				content: message.content,
				details: { wait: message.details },
				display: true,
			};
			// TASK-0081: the crew-wait-resume MODEL delivery is a Bebop-owned
			// delivery; a local blocking idle wait wakes on it (a Response on the
			// request-scoped RPC channel alone is not a wake).
			notifyAcceptedMessage(
				state,
				`wait-resume-${String((message.details as { waitId?: string }).waitId ?? "")}`,
			);
			if (isIdle) state.modelDelivery?.send(customMessage, { triggerTurn: true });
			else state.modelDelivery?.send(customMessage, { triggerTurn: true, deliverAs: message.deliverAs });
		},
		isRunIdle: () => state.context?.isIdle?.() === true,
		// TASK-0080: shared events are fire-and-forget session entries with the
		// exact { waitId, kind } payload; zero listeners is a no-op.
		publish: (event) => pi.appendEntry(event.type, { waitId: event.waitId, kind: event.kind }),
	});
	registerSendMemberRequestTool(pi, state);
	registerRespondToMemberRequestTool(pi, state);
	registerWaitForRequestOutcomeTool(pi, state, yieldRuntime);
	const memberMessageDependencies = {
		transport: { send: sendRpcCommand },
		resolveEndpoint: resolveMemberEndpoint,
		coordinator: createMemberMessageCoordinator(),
	};
	registerSendFollowUpTool(pi, state, memberMessageDependencies);
	registerRedirectMemberTool(pi, state, memberMessageDependencies);
	registerSendToInboxTool(pi, state);
	registerSendToCrewTool(pi, state);
	registerBroadcastToCrewTool(pi, state, { isProjectTrusted: () => state.context?.isProjectTrusted?.() === true });
	registerInterruptMemberTool(pi, state);
	const memberStatusTransport = createMemberStatusTransport();
	registerGetMemberStatusTool(pi, state, memberStatusTransport);
	registerWaitForMemberIdleTool(pi, state, {
		probeEndpoint: (socketPath) => probeMemberEndpoint(socketPath),
		requestIdleWait: async (endpoint, memberLabel, { timeoutSeconds, signal }) => {
			try {
				const resolved = await resolveMemberEndpoint(endpoint);
				const command: MemberIdleWaitCommand = { type: "member_idle_wait", member: memberLabel };
				return await sendMemberIdleWait(resolved, command, { timeoutSeconds, signal });
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
				return { ok: false, code: "transport-error" };
			}
		},
	});
	const crewIdleWaitTransport = createCrewIdleWaitTransport({
		getCurrentMember: () => state.membershipRuntime?.getMembership()?.member ?? null,
		status: memberStatusTransport,
	});
	const crewIdleWaitFlow = createCrewIdleWaitFlow({
		getMembership: () => state.membershipRuntime?.getMembership() ?? null,
		isTrusted: () => state.context?.isProjectTrusted?.() === true,
		now: () => new Date().toISOString(),
		requestStatus: (member, signal) => crewIdleWaitTransport.requestStatus(member, signal),
		requestWaitState: (member, options) => crewIdleWaitTransport.requestWaitState(member, options),
		requestMemberIdle: (member, options) => crewIdleWaitTransport.requestMemberIdle(member, options),
	});
	registerWaitForCrewIdleTool(pi, state, crewIdleWaitTransport);
	registerLeaveCrewPostTool(pi, state, {
		isProjectTrusted: () => state.context?.isProjectTrusted?.() === true,
		getCurrentMembership: () => state.membershipRuntime?.getMembership() ?? null,
		openStore: (options) => openTrustedCrewBoardStore(options),
	});
	registerReadCrewBoardTool(pi, state, {
		isProjectTrusted: () => state.context?.isProjectTrusted?.() === true,
		getCurrentMembership: () => state.membershipRuntime?.getMembership() ?? null,
		openStore: (options) => openTrustedCrewBoardStore(options),
	});
	// Membership tools stay registered (getAllTools) and are deactivated at
	// session_start before the first agent request: Pi's extension runtime does
	// NOT allow action methods (getActiveTools/setActiveTools) during extension
	// loading, so the unjoined reconcile must run in the session_start handler.
	const persistMembership = (active: boolean, membership: import("./infra/membership-runtime.ts").Membership) => {
		pi.appendEntry(MEMBERSHIP_ENTRY_TYPE, membershipStateFromRuntime(membership, active));
	};
	const announceMembership = (message: string) => {
		// Durable TUI-only custom entry: human-visible, never part of LLM context.
		pi.appendEntry("crew-status", { content: message });
	};

	const presenceComposition = createPresenceComposition({
		getMembership: () => {
			const membership = state.membershipRuntime?.getMembership();
			if (!membership) return null;
			const members = membership.manifest.members.map((member) => ({
				identity: member.socketPath,
				name: member.name,
				role: member.role,
			}));
			return {
				member: {
					identity: membership.member.socketPath,
					name: membership.member.name,
					role: membership.member.role,
				},
				notifications: membership.manifest.presence.notifications,
				members,
				fingerprint: JSON.stringify({
					current: {
						identity: membership.member.socketPath,
						name: membership.member.name,
						role: membership.member.role,
					},
					members,
					notifications: membership.manifest.presence.notifications,
				}),
			};
		},
		createObserver: (membership, onEffects) => {
			const instanceId = state.context?.sessionManager.getSessionId() ?? "";
			return createPresenceObserverAdapter(membership, instanceId, {
				scheduler: {
					schedule: (delay, callback) => setTimeout(callback, delay),
					cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
				},
				probe: (identity, timeout) => probeMemberEndpoint(identity, { timeoutMs: timeout }),
				resolveTarget: resolveMemberEndpoint,
				send: async (endpoint, payload, timeout) => {
					await sendRpcCommand(endpoint, { type: "presence_hint", ...payload }, { timeout });
				},
				onEffects,
			});
		},
		sendMessage: (message, options) => state.modelDelivery?.send(message, options),
		onObserverChanged: (observer) => {
			state.presenceObserver = observer;
		},
		reportFailure: () => reportLifecycleFailure(state.context),
	});
	const stopPresence = async () => {
		await presenceComposition.stop();
		state.presenceObserver = undefined;
	};
	const refreshPresence = () => presenceComposition.refresh();

	registerSessionControlCommand(
		pi,
		state,
		{
			disableControlServer: (currentState, ctx) => disableControlServer(currentState, ctx, pi),
			ensureControlServer: (api, currentState, ctx) => ensureControlServer(api, currentState, ctx),
			membershipRuntime: state.membershipRuntime,
			persistMembership,
			announceMembership,
			activateMembershipTool: () => activateMembershipTool(pi),
			deactivateMembershipTool: () => deactivateMembershipTool(pi),
			refreshStatus: () => refreshIntrayStatus(state),
			refreshPresence,
			stopPresence,
			syncSessionName: async (membership) => {
				sessionNameController.syncMembership(membership);
				await refreshSessionAliases(state);
			},
			inboxBridge,
			crewBoard: {
				isProjectTrusted: () => state.context?.isProjectTrusted?.() === true,
				getCurrentMembership: () => state.membershipRuntime?.getMembership() ?? null,
				openStore: (options) => openTrustedCrewBoardStore(options),
			},
			crewBoardNow: () => Date.now(),
			crewIdleWait: crewIdleWaitFlow,
			activateAgreementRevision: async (revisionId, ctx) => {
				const membership = state.membershipRuntime?.getMembership();
				if (!membership) throw new Error("Crew is not joined");
				const result = await activateAgreementRevision(membership, revisionId, {
					isProjectTrusted: () => ctx.isProjectTrusted(),
					openAgreementStore: openTrustedCrewAgreementStore,
					openInboxStore: openTrustedMemberInboxStore,
					now: () => Date.now(),
				});
				return { ...result.activation, notices: result.notices };
			},
		},
		"crew",
	);

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await handleSessionStart(pi, state, ctx, {
			inboxBridge,
			recoverInterrupts,
			refreshPresence,
			persistMembership,
			announceMembership,
			restoreSessionName: (entries) => sessionNameController.restore(entries),
			syncSessionName: async (membership) => {
				sessionNameController.syncMembership(membership);
				await refreshSessionAliases(state, ctx);
			},
		});
	});

	pi.on("session_info_changed", (event, ctx) => {
		sessionNameController.observeChange(event.name);
		void refreshSessionAliases(state, ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const membership = state.membershipRuntime?.getMembership();
		if (!membership) return;
		return { systemPrompt: appendMembershipContext(event.systemPrompt, membership) };
	});

	pi.on("session_shutdown", async () => {
		cancelCrewMemberIdleCommand(state, "session-shutdown");
		inboxBridge.invalidate();
		const context = state.context;
		// TASK-0080: shutdown cancels every parked wait (wait-cancelled per id,
		// no resumes queued) so no stale wait survives the session; auto clears
		// its suspension via the cancelled events and no work is resumed.
		yieldRuntime.cancelAll();
		await releaseMembershipBeforeCleanup({
			hasMembership: Boolean(state.membershipRuntime?.getMembership()),
			leave: async () => state.membershipRuntime!.leave(),
			onReleased: async () => {
				await stopPresence();
			},
			cleanup: async () => {
				await stopPresence();
				sessionNameController.syncMembership(null);
				deactivateMembershipTool(pi);
				await disableControlServer(state, context, pi);
			},
			reportFailure: () => reportLifecycleFailure(context),
		});
		state.context = null;
		state.socketPath = null;
	});

	// TASK-0139: at model handoff of a queued Follow-up, replace it once with
	// immutable target-observed queue provenance (label + may-predate
	// guidance). Direct/steered/historical messages stay untouched.
	pi.on("message_end", (event: MessageEndEvent) => queuedFollowUpMessageEndResult(state, event.message));

	pi.on("turn_end", (event, ctx) => {
		emitTurnEnd(state, event, ctx);
		void inboxBridge.attemptOffer();
	});

	// One-shot member idle waits complete ONLY from Pi `agent_settled` (TASK-0051).
	// `agent_end` and `turn_end` are intentionally ignored: retry, compaction,
	// and queued continuation work must be exhausted before `became-idle`.
	pi.on("agent_settled", (_event, ctx) => {
		emitIdleSettled(state, ctx);
		// TASK-0080: the outcome turn of any started resume settled -> emit
		// wait-resume-settled once per waitId; unrelated settles publish nothing.
		yieldRuntime.markSettled();
	});

	// TASK-0080: a run started while resumes were queued -> those resumes
	// entered model context (the OUTCOME TURN); emit wait-resume-started per id.
	pi.on("agent_start", () => {
		cancelCrewMemberIdleCommand(state, "local-activity");
		yieldRuntime.markStarted();
	});

	// Terminal compaction handlers run before Pi's internal cleanup. The gate
	// schedules an injected post-event task and re-checks depth/generation there.
	const compactionGenerations: number[] = [];
	pi.on("session_before_compact", () => {
		compactionGenerations.push(state.modelDelivery?.compactionStarted() ?? 0);
	});
	const onCompactionTerminal = (_event: unknown, ctx: ExtensionContext) => {
		const generation = compactionGenerations.pop();
		if (generation !== undefined) state.modelDelivery?.compactionEnded(generation);
		emitIdleSettled(state, ctx);
	};
	pi.on("session_compact" as never, onCompactionTerminal as never);
	pi.on("session_compact_failed" as never, onCompactionTerminal as never);
}
