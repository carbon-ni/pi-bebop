/**
 * Intray Extension
 *
 * Enables inter-session communication via Unix domain sockets. When enabled with
 * the `--intray` flag, each session creates an intray socket at
 * `~/.pi/intray/<session-id>.sock` that accepts JSON-RPC commands.
 *
 * Features:
 * - Send to joined crew roles with `send_to_member` or explicit targets with `send_to_session`
 * - Retrieve/clear sessions and subscribe to turn_end events for legacy coordination
 *
 *
 * Usage:
 *   pi --intray
 *
 * One-shot startup send:
 *   pi -p --intray --control-session <session-name|session-id> --send-session-message <text>
 *     [--send-session-mode steer|follow_up] [--send-session-wait turn_end|message_processed]
 *     [--send-session-include-sender-info]
 *   (startup send is one-way by default; use --send-session-wait turn_end to capture response on stdout)
 *
 * Environment:
 *   Sets PI_SESSION_ID when enabled, allowing child processes to discover
 *   the current session.
 *
 * RPC Protocol:
 *   Commands are newline-delimited JSON objects with a `type` field:
 *   - { type: "send", message: "...", mode?: "steer"|"follow_up" }
 *   - { type: "status" }
 *   - { type: "get_message" }, { type: "clear" }, { type: "abort" }
 *   - { type: "subscribe", event: "turn_end" }
 *
 *   Responses are JSON objects with { type: "response", command, success, data?, error? }
 *   Events are JSON objects with { type: "event", event, data?, subscriptionId? }
 */

import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { renderSessionMessage } from "./pi/message-renderer.ts";
import { maybeHandleStartupControlSend, maybeHandleStartupSocketJoin } from "./pi/startup-send.ts";
import { registerSessionControlCommand } from "./pi/control-commands.ts";
import { registerListSessionsTool, registerMemberTool, registerSessionTool } from "./tools/index.ts";
import { activateMembershipTool, createSocketState, deactivateMembershipTool, disableControlServer, emitTurnEnd, enableControlServer, ensureControlServer, refreshIntrayStatus } from "./pi/control-runtime.ts";
import { CONTROL_FLAG, CONTROL_SHORT_FLAG, isSafeAlias, isSafeSessionId, isSessionControlRequested, normalizeMode, normalizeWaitUntil, parseSessionControlAction, SESSION_MESSAGE_TYPE } from "./domain/index.ts";
import { isIntrayEnabledByConfig } from "./infra/intray-config.ts";
import { getCrewManifestPathFromSocketPath, readTrustedCrewManifest } from "./infra/crew-manifest-store.ts";
import { createMembershipRuntime } from "./infra/membership-runtime.ts";
import { appendMembershipContext, getLatestMembershipState, MEMBERSHIP_ENTRY_TYPE, membershipStateFromRuntime } from "./pi/membership-context.ts";
import { chooseMembershipServerMode, prepareMembershipServer, releaseMembershipBeforeCleanup, restorePersistedMembership } from "./pi/membership-lifecycle.ts";
export { isSafeAlias, isSafeSessionId, isSessionControlRequested, normalizeMode, normalizeWaitUntil, parseCommand, parseSessionControlAction } from "./domain/index.ts";

const CONTROL_TARGET_FLAG = "control-session";
const CONTROL_SEND_MESSAGE_FLAG = "send-session-message";
const CONTROL_SEND_MODE_FLAG = "send-session-mode";
const CONTROL_SEND_WAIT_FLAG = "send-session-wait";
const CONTROL_SEND_INCLUDE_SENDER_FLAG = "send-session-include-sender-info";
const STARTUP_SOCKET_FLAG = "intray-socket";

function shouldRegisterControlTools(pi: ExtensionAPI): boolean {
	return isSessionControlRequested((name) => pi.getFlag(name))
		|| typeof pi.getFlag(STARTUP_SOCKET_FLAG) === "string"
		|| isIntrayEnabledByConfig();
}

function configureInitialControlTools(pi: ExtensionAPI): void {
	const intrayTools = new Set(["send_to_session", "list_sessions", "send_to_member"]);
	if (shouldRegisterControlTools(pi)) {
		pi.setActiveTools([...pi.getActiveTools().filter((name) => !intrayTools.has(name)), "send_to_session", "list_sessions"]);
		return;
	}
	pi.setActiveTools(pi.getActiveTools().filter((name) => !intrayTools.has(name)));
}

// ============================================================================
// Extension Export
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerFlag(CONTROL_FLAG, {
		description: "Enable an intray socket under ~/.pi/intray",
		type: "boolean",
	});
	pi.registerFlag(CONTROL_SHORT_FLAG, {
		description: "Alias for --intray",
		type: "boolean",
	});
	pi.registerFlag(CONTROL_TARGET_FLAG, {
		description: "Target session name or session id for startup control send",
		type: "string",
	});
	pi.registerFlag(CONTROL_SEND_MESSAGE_FLAG, {
		description: "Message to send to --control-session at startup",
		type: "string",
	});
	pi.registerFlag(CONTROL_SEND_MODE_FLAG, {
		description: "Startup send mode: steer or follow_up",
		type: "string",
		default: "steer",
	});
	pi.registerFlag(CONTROL_SEND_WAIT_FLAG, {
		description: "Startup send wait mode: turn_end or message_processed",
		type: "string",
	});
	pi.registerFlag(CONTROL_SEND_INCLUDE_SENDER_FLAG, {
		description: "Include <sender_info> in startup messages (advanced; default: false)",
		type: "boolean",
	});
	pi.registerFlag(STARTUP_SOCKET_FLAG, {
		description: "Select a crew socket path as the current intray identity",
		type: "string",
	});

	let cliSendHandled = false;

	const state = createSocketState();
	state.membershipRuntime = createMembershipRuntime({
		loadManifest: async (manifestPath) => {
			const context = state.context;
			if (!context) throw new Error("Session context is not ready");
			const projectRoot = path.resolve(path.dirname(manifestPath), "..", "..");
			return readTrustedCrewManifest(manifestPath, projectRoot, () => context.isProjectTrusted());
		},
	});

	pi.registerMessageRenderer(SESSION_MESSAGE_TYPE, renderSessionMessage);

	registerSessionTool(pi, state);
	registerListSessionsTool(pi);
	registerMemberTool(pi, state);
	const persistMembership = (active: boolean, membership: import("./infra/membership-runtime.ts").Membership) => {
		pi.appendEntry(MEMBERSHIP_ENTRY_TYPE, membershipStateFromRuntime(membership, active));
	};
	const announceMembership = (message: string) => {
		pi.sendMessage({ customType: "intray-status", content: message, display: true }, { triggerTurn: false });
	};

	registerSessionControlCommand(pi, state, {
		disableControlServer: (currentState, ctx) => disableControlServer(currentState, ctx, pi),
		membershipRuntime: state.membershipRuntime,
		getCrewManifestPathFromSocketPath,
		persistMembership,
		announceMembership,
		activateMembershipTool: () => activateMembershipTool(pi),
		deactivateMembershipTool: () => deactivateMembershipTool(pi),
		refreshStatus: () => refreshIntrayStatus(state),
	});

	const refreshServer = async (ctx: ExtensionContext, restoreMembership = false) => {
		const mode = chooseMembershipServerMode({
			controlRequested: isSessionControlRequested((name) => pi.getFlag(name)),
			configEnabled: isIntrayEnabledByConfig(),
			startupSocketSelected: typeof pi.getFlag(STARTUP_SOCKET_FLAG) === "string" && String(pi.getFlag(STARTUP_SOCKET_FLAG)).trim().length > 0,
			persistedMembershipActive: restoreMembership,
		});
		await prepareMembershipServer(mode, {
			ensure: () => ensureControlServer(pi, state, ctx),
			enable: () => enableControlServer(pi, state, ctx),
			disable: () => disableControlServer(state, ctx),
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		configureInitialControlTools(pi);
		if (state.server) {
			await disableControlServer(state, state.context ?? ctx, pi);
		}
		const startupSocket = typeof pi.getFlag(STARTUP_SOCKET_FLAG) === "string" && String(pi.getFlag(STARTUP_SOCKET_FLAG)).trim().length > 0;
		const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
		const persisted = getLatestMembershipState(branch);
		await refreshServer(ctx, !startupSocket && persisted?.active === true);
		if (startupSocket) {
			const joined = await maybeHandleStartupSocketJoin(ctx, pi, { socket: STARTUP_SOCKET_FLAG }, state.membershipRuntime, state.socketPath);
			const currentMembership = state.membershipRuntime?.getMembership();
			if (joined && currentMembership) {
				activateMembershipTool(pi);
				refreshIntrayStatus(state, ctx);
				persistMembership(true, currentMembership);
				announceMembership(`Intray joined ${currentMembership.member.name} (${currentMembership.member.role}) at ${currentMembership.socketPath}`);
			}
		} else if (state.membershipRuntime) {
			await restorePersistedMembership({
				runtime: state.membershipRuntime,
				persisted,
				startupSocketSelected: startupSocket,
				globalSocketPath: state.socketPath,
				manifestPathForSocket: getCrewManifestPathFromSocketPath,
				announce: (message) => {
					activateMembershipTool(pi);
					refreshIntrayStatus(state, ctx);
					announceMembership(message);
				},
				reportFailure: (message) => {
					const failure = `Intray membership restore failed: ${message}`;
					if (ctx.hasUI) ctx.ui.notify(failure, "error");
					else console.error(failure);
				},
			});
		}
		if (!cliSendHandled) {
			cliSendHandled = true;
			await maybeHandleStartupControlSend(pi, ctx, {
				target: CONTROL_TARGET_FLAG,
				message: CONTROL_SEND_MESSAGE_FLAG,
				mode: CONTROL_SEND_MODE_FLAG,
				wait: CONTROL_SEND_WAIT_FLAG,
				includeSender: CONTROL_SEND_INCLUDE_SENDER_FLAG,
			});
		}
	});

	pi.on("before_agent_start", async (event) => {
		const membership = state.membershipRuntime?.getMembership();
		if (!membership) return;
		return { systemPrompt: appendMembershipContext(event.systemPrompt, membership) };
	});

	pi.on("session_shutdown", async () => {
		const context = state.context;
		await releaseMembershipBeforeCleanup({
			hasMembership: Boolean(state.membershipRuntime?.getMembership()),
			leave: async () => state.membershipRuntime!.leave(),
			cleanup: async () => {
				deactivateMembershipTool(pi);
				await disableControlServer(state, context, pi);
			},
			reportFailure: (message) => {
				if (context?.hasUI) context.ui.notify(message, "error");
				else console.error(message);
			},
		});
	});

	pi.on("turn_end", (event, ctx) => emitTurnEnd(state, event, ctx));
}
