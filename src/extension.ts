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
	ensureControlServer,
	refreshIntrayStatus,
} from "./pi/control-runtime.ts";
import { createGuestComposition } from "./pi/guest-composition.ts";
import {
	CREW_FLAG,
	CREW_ROLE_FLAG,
	CREW_SOCKET_FLAG,
	GUEST_AS_FLAG,
	GUEST_JOIN_FLAG,
	createMembershipRecording,
	registerSessionLifecycle,
	wireMembershipRuntime,
} from "./pi/session-lifecycle-composition.ts";
import { createInboxBridgeController } from "./pi/inbox-bridge-runtime.ts";
import { createInterruptFlow } from "./application/interrupt-flow.ts";
import { SESSION_MESSAGE_TYPE } from "./domain/index.ts";
import { MemberRequestFlow } from "./application/member-request-flow.ts";

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
	pi.registerFlag(GUEST_AS_FLAG, {
		description: "Guest display name for repeatable startup admission requests",
		type: "string",
	});
	pi.registerFlag(GUEST_JOIN_FLAG, {
		description: "Member socket to request Guest admission from (repeatable)",
		type: "string",
	});

	pi.registerMessageRenderer(SESSION_MESSAGE_TYPE, renderSessionMessage);
	pi.registerMessageRenderer("crew-presence", renderCrewPresence);
	pi.registerMessageRenderer("crew-interrupt", renderCrewInterrupt);
	pi.registerEntryRenderer("crew-roster", renderCrewRosterEntry);
	pi.registerEntryRenderer("crew-status", renderCrewStatusEntry);
	pi.registerEntryRenderer("crew-inbox", renderCrewInboxEntry);

	const state = createSocketState(Date.now);
	const guestComposition = createGuestComposition(pi, state);
	wireMembershipRuntime(state);
	const membershipRecording = createMembershipRecording(pi);

	const inboxBridge = createInboxBridgeController(pi, state, { now: Date.now });
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
			now: state.now,
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
		now: Date.now,
		approvedGuests: guestComposition.approvedGuests,
	};
	registerSendFollowUpTool(pi, state, memberMessageDependencies);
	registerRedirectMemberTool(pi, state, memberMessageDependencies);
	registerSendToInboxTool(pi, state);
	registerBroadcastToCrewTool(pi, state, memberMessageDependencies);
	registerInterruptMemberTool(pi, state);
	registerGetMemberStatusTool(pi, state, createMemberStatusTransport());
	registerWaitForMemberIdleTool(pi, state, {
		probeEndpoint: (socketPath) => probeMemberEndpoint(socketPath),
		requestIdleWait: async (endpoint, memberLabel, { timeoutSeconds, signal }) => {
			try {
				const resolved = await resolveMemberEndpoint(endpoint);
				const command: MemberIdleWaitCommand = {
					type: "member_idle_wait",
					member: memberLabel,
					forwarded: true,
				};
				return await sendMemberIdleWait(resolved, command, { timeoutSeconds, signal });
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
				return { ok: false, code: "transport-error" };
			}
		},
	});

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

	// Membership tools stay registered (getAllTools) and are deactivated at
	// session_start before the first agent request: Pi's extension runtime does
	// NOT allow action methods (getActiveTools/setActiveTools) during extension
	// loading, so the unjoined reconcile must run in the session_start handler.
	registerSessionControlCommand(
		pi,
		state,
		{
			disableControlServer: (currentState, ctx) => disableControlServer(currentState, ctx, pi),
			ensureControlServer: (api, currentState, ctx) => ensureControlServer(api, currentState, ctx),
			membershipRuntime: state.membershipRuntime,
			persistMembership: membershipRecording.persistMembership,
			announceMembership: membershipRecording.announceMembership,
			activateMembershipTool: () => activateMembershipTool(pi),
			deactivateMembershipTool: () => deactivateMembershipTool(pi),
			refreshStatus: () => refreshIntrayStatus(state),
			refreshGuestAdmission: guestComposition.refreshAdmission,
			refreshPresence,
			stopPresence,
			inboxBridge,
		},
		"crew",
	);
	guestComposition.registerControlCommand();
	registerSessionLifecycle(pi, state, {
		refreshGuestAdmission: guestComposition.refreshAdmission,
		ensureGuestMessagingTools: guestComposition.ensureMessagingTools,
		inboxBridge,
		recoverInterrupts,
		refreshPresence,
		stopPresence,
	});
}
