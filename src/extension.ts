import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSessionControlCommand } from "./pi/control-commands.ts";
import {
	renderCrewPresence,
	renderCrewRosterEntry,
	renderCrewStatusEntry,
	renderCrewInboxEntry,
	renderSessionMessage,
	renderCrewInterrupt,
} from "./pi/message-renderer.ts";
import {
	registerSendFollowUpTool,
	registerRedirectMemberTool,
	registerSendToInboxTool,
	registerBroadcastToCrewTool,
	registerInterruptMemberTool,
	registerGetMemberStatusTool,
	registerWaitForMemberIdleTool,
	registerSendMemberRequestTool,
	registerRespondToMemberRequestTool,
	registerWaitForRequestOutcomeTool,
} from "./tools/index.ts";
import { createMemberMessageCoordinator } from "./application/member-message.ts";
import { createPresenceComposition } from "./pi/presence-composition.ts";
import { createPresenceObserverAdapter } from "./application/presence-adapter.ts";
import { createMemberStatusTransport } from "./infra/member-status-transport.ts";
import { sendMemberIdleWait, sendRpcCommand, sendMemberRequest } from "./infra/rpc-client.ts";
import { resolveMemberEndpoint } from "./infra/socket-endpoint.ts";
import { probeMemberEndpoint } from "./infra/member-endpoint.ts";
import { type MemberIdleWaitCommand } from "./domain/index.ts";
import {
	activateMembershipTool,
	createSocketState,
	deactivateMembershipTool,
	disableControlServer,
	emitIdleSettled,
	emitTurnEnd,
	ensureControlServer,
	reconcileMembershipTools,
	refreshIntrayStatus,
} from "./pi/control-runtime.ts";
import { getSocketPath } from "./infra/intray-paths.ts";
import { getCrewManifestPathFromSocketPath, readTrustedCrewManifest } from "./infra/crew-manifest-store.ts";
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
	startupRoleSelectionError,
	type StartupRoleSelection,
} from "./pi/startup-send.ts";
import { createInboxBridgeController, ownershipFromMembership } from "./pi/inbox-bridge-runtime.ts";
import { createInterruptFlow } from "./application/interrupt-flow.ts";
import { SESSION_MESSAGE_TYPE } from "./domain/index.ts";
import { MemberRequestFlow } from "./application/member-request-flow.ts";

const CREW_FLAG = "crew";
const CREW_SOCKET_FLAG = "crew-socket";
const CREW_ROLE_FLAG = "crew-role";

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
	pi.registerMessageRenderer("crew-presence", renderCrewPresence);
	pi.registerMessageRenderer("crew-interrupt", renderCrewInterrupt);
	pi.registerEntryRenderer("crew-roster", renderCrewRosterEntry);
	pi.registerEntryRenderer("crew-status", renderCrewStatusEntry);
	pi.registerEntryRenderer("crew-inbox", renderCrewInboxEntry);

	const state = createSocketState();
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
			pi.sendMessage(
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
	registerSendMemberRequestTool(pi, state);
	registerRespondToMemberRequestTool(pi, state);
	registerWaitForRequestOutcomeTool(pi, state);
	const memberMessageDependencies = {
		transport: { send: sendRpcCommand },
		resolveEndpoint: resolveMemberEndpoint,
		coordinator: createMemberMessageCoordinator(),
	};
	registerSendFollowUpTool(pi, state, memberMessageDependencies);
	registerRedirectMemberTool(pi, state, memberMessageDependencies);
	registerSendToInboxTool(pi, state);
	registerBroadcastToCrewTool(pi, state, { isProjectTrusted: () => state.context?.isProjectTrusted?.() === true });
	registerInterruptMemberTool(pi, state);
	registerGetMemberStatusTool(pi, state, createMemberStatusTransport());
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
		sendMessage: (message, options) => pi.sendMessage(message, options),
		onObserverChanged: (observer) => {
			state.presenceObserver = observer;
		},
		reportFailure: (error) => console.error(`Crew presence failed: ${String(error)}`),
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
			inboxBridge,
		},
		"crew",
	);

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const startupSocket =
			typeof pi.getFlag(CREW_SOCKET_FLAG) === "string" && String(pi.getFlag(CREW_SOCKET_FLAG)).trim().length > 0;
		const rawCrewRole = pi.getFlag(CREW_ROLE_FLAG);
		const startupRole = typeof rawCrewRole === "string" && rawCrewRole.trim().length > 0;
		if (rawCrewRole !== undefined && rawCrewRole !== false && (!startupRole || typeof rawCrewRole !== "string")) {
			reconcileMembershipTools(pi, false);
			ctx.hasUI
				? ctx.ui.notify("Invalid --crew-role: role must be non-empty", "error")
				: console.error("Invalid --crew-role: role must be non-empty");
			return;
		}
		if (startupSocket && startupRole) {
			reconcileMembershipTools(pi, false);
			ctx.hasUI
				? ctx.ui.notify("Choose exactly one of --crew-role or --crew-socket", "error")
				: console.error("Choose exactly one of --crew-role or --crew-socket");
			return;
		}
		let startupRoleSelection: StartupRoleSelection | undefined;
		if (startupRole) {
			try {
				startupRoleSelection = await resolveStartupCrewRole(
					String(rawCrewRole),
					ctx.cwd,
					ctx.isProjectTrusted(),
				);
			} catch (error) {
				reconcileMembershipTools(pi, false);
				const message = error instanceof Error ? error.message : "manifest read failed";
				ctx.hasUI
					? ctx.ui.notify(`Crew startup role join failed: ${message}`, "error")
					: console.error(`Crew startup role join failed: ${message}`);
				return;
			}
			if (startupRoleSelection && "code" in startupRoleSelection) {
				reconcileMembershipTools(pi, false);
				const message = `Crew startup role join failed: ${startupRoleSelectionError(startupRoleSelection)}`;
				ctx.hasUI ? ctx.ui.notify(message, "error") : console.error(message);
				return;
			}
		}
		const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
		const persisted = getLatestMembershipState(branch);
		const crewRequested = pi.getFlag(CREW_FLAG) === true || process.argv.includes(`--${CREW_FLAG}`);
		if (crewRequested || startupSocket || startupRole || persisted?.active === true) {
			await ensureControlServer(pi, state, ctx);
		} else {
			state.context = ctx;
			state.socketPath = getSocketPath(ctx.sessionManager.getSessionId());
			// New unjoined session: base server may be off; membership tools stay inactive.
			reconcileMembershipTools(pi, false);
		}
		if (startupRole || startupSocket) {
			const joined = startupRole
				? await maybeHandleStartupRoleJoin(
						ctx,
						pi,
						{ role: CREW_ROLE_FLAG },
						state.membershipRuntime,
						state.socketPath,
						async () => startupRoleSelection!,
					)
				: await maybeHandleStartupSocketJoin(
						ctx,
						pi,
						{ socket: CREW_SOCKET_FLAG },
						state.membershipRuntime,
						state.socketPath,
					);
			const membership = state.membershipRuntime.getMembership();
			if (joined && membership) {
				activateMembershipTool(pi);
				await refreshPresence();
				persistMembership(true, membership);
				announceMembership(
					`Crew joined ${membership.member.name} (${membership.member.role}) at ${membership.socketPath}`,
				);
				inboxBridge.establish(ownershipFromMembership(membership));
				void inboxBridge.attemptOffer();
				void recoverInterrupts();
			} else {
				// Startup socket selected but join failed: stay unjoined, tools inactive.
				reconcileMembershipTools(pi, false);
			}
			return;
		}
		await restorePersistedMembership({
			runtime: state.membershipRuntime,
			persisted,
			startupSocketSelected: false,
			globalSocketPath: state.socketPath,
			manifestPathForSocket: getCrewManifestPathFromSocketPath,
			announce: async (message) => {
				activateMembershipTool(pi);
				await refreshPresence();
				announceMembership(message);
				const membership = state.membershipRuntime?.getMembership();
				if (membership) {
					inboxBridge.establish(ownershipFromMembership(membership));
					void inboxBridge.attemptOffer();
					void recoverInterrupts();
				}
			},
			reportFailure: (message) => {
				if (ctx.hasUI) ctx.ui.notify(`Crew membership restore failed: ${message}`, "error");
				else console.error(`Crew membership restore failed: ${message}`);
			},
		});
		// Inactive resume/fork state, restore failure, or server-only startup: ensure
		// membership tools are not active for the model.
		if (!state.membershipRuntime?.getMembership()) reconcileMembershipTools(pi, false);
	});

	pi.on("before_agent_start", async (event) => {
		const membership = state.membershipRuntime?.getMembership();
		if (!membership) return;
		return { systemPrompt: appendMembershipContext(event.systemPrompt, membership) };
	});

	pi.on("session_shutdown", async () => {
		inboxBridge.invalidate();
		const context = state.context;
		await releaseMembershipBeforeCleanup({
			hasMembership: Boolean(state.membershipRuntime?.getMembership()),
			leave: async () => state.membershipRuntime!.leave(),
			onReleased: async () => {
				await stopPresence();
			},
			cleanup: async () => {
				await stopPresence();
				deactivateMembershipTool(pi);
				await disableControlServer(state, context, pi);
			},
			reportFailure: (message) => {
				if (context?.hasUI) context.ui.notify(message, "error");
				else console.error(message);
			},
		});
		state.context = null;
		state.socketPath = null;
	});

	pi.on("turn_end", (event, ctx) => {
		emitTurnEnd(state, event, ctx);
		void inboxBridge.attemptOffer();
	});

	// One-shot member idle waits complete ONLY from Pi `agent_settled` (TASK-0051).
	// `agent_end` and `turn_end` are intentionally ignored: retry, compaction,
	// and queued continuation work must be exhausted before `became-idle`.
	pi.on("agent_settled", (_event, ctx) => {
		emitIdleSettled(state, ctx);
	});

	// Manual/branch compaction can settle while the agent run flag is already
	// idle; re-evaluate the same combined predicate on Pi's balanced lifecycle end.
	// TASK-0069 is supplied by the upgraded Pi peer. Keep loading compatible
	// with older peers: the event is additive and the handler is inert there.
	const onCompactionEnd = (_event: unknown, ctx: ExtensionContext) => {
		emitIdleSettled(state, ctx);
	};
	pi.on("session_compaction_end" as never, onCompactionEnd as never);
}
