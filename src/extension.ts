import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSessionControlCommand } from "./pi/control-commands.ts";
import {
	renderCrewPresence,
	renderCrewRoster,
	renderSessionMessage,
	renderCrewInterrupt,
} from "./pi/message-renderer.ts";
import {
	registerSendFollowUpTool,
	registerRedirectMemberTool,
	registerSendToInboxTool,
	registerBroadcastToCrewTool,
	registerInterruptMemberTool,
} from "./tools/index.ts";
import { createMemberMessageCoordinator } from "./application/member-message.ts";
import { createPresenceComposition } from "./pi/presence-composition.ts";
import { createPresenceObserverAdapter } from "./application/presence-adapter.ts";
import { sendRpcCommand } from "./infra/rpc-client.ts";
import { resolveMemberEndpoint } from "./infra/socket-endpoint.ts";
import { probeMemberEndpoint } from "./infra/member-endpoint.ts";
import {
	activateMembershipTool,
	createSocketState,
	deactivateMembershipTool,
	disableControlServer,
	emitTurnEnd,
	ensureControlServer,
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
import { maybeHandleStartupSocketJoin } from "./pi/startup-send.ts";
import { createInboxBridgeController, ownershipFromMembership } from "./pi/inbox-bridge-runtime.ts";
import { createInterruptFlow } from "./application/interrupt-flow.ts";
import { SESSION_MESSAGE_TYPE } from "./domain/index.ts";

const CREW_FLAG = "crew";
const CREW_SOCKET_FLAG = "crew-socket";

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

	pi.registerMessageRenderer(SESSION_MESSAGE_TYPE, renderSessionMessage);
	pi.registerMessageRenderer("crew-roster", renderCrewRoster);
	pi.registerMessageRenderer("crew-presence", renderCrewPresence);
	pi.registerMessageRenderer("crew-interrupt", renderCrewInterrupt);

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
	const persistMembership = (active: boolean, membership: import("./infra/membership-runtime.ts").Membership) => {
		pi.appendEntry(MEMBERSHIP_ENTRY_TYPE, membershipStateFromRuntime(membership, active));
	};
	const announceMembership = (message: string) => {
		pi.sendMessage({ customType: "crew-status", content: message, display: true }, { triggerTurn: false });
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
		const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
		const persisted = getLatestMembershipState(branch);
		const crewRequested = pi.getFlag(CREW_FLAG) === true || process.argv.includes(`--${CREW_FLAG}`);
		if (crewRequested || startupSocket || persisted?.active === true) {
			await ensureControlServer(pi, state, ctx);
		} else {
			state.context = ctx;
			state.socketPath = getSocketPath(ctx.sessionManager.getSessionId());
		}
		if (startupSocket) {
			const joined = await maybeHandleStartupSocketJoin(
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
}
