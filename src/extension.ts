import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSessionControlCommand } from "./pi/control-commands.ts";
import { registerMemberTool } from "./tools/index.ts";
import { activateMembershipTool, createSocketState, deactivateMembershipTool } from "./pi/control-runtime.ts";
import { getSocketPath } from "./infra/intray-paths.ts";
import { getCrewManifestPathFromSocketPath, readTrustedCrewManifest } from "./infra/crew-manifest-store.ts";
import { createMembershipRuntime } from "./infra/membership-runtime.ts";
import { appendMembershipContext, getLatestMembershipState, MEMBERSHIP_ENTRY_TYPE, membershipStateFromRuntime } from "./pi/membership-context.ts";
import { releaseMembershipBeforeCleanup, restorePersistedMembership } from "./pi/membership-lifecycle.ts";
import { maybeHandleStartupSocketJoin } from "./pi/startup-send.ts";

const CREW_SOCKET_FLAG = "crew-socket";

/**
 * Crew management layered on the separately installed pi-intray extension.
 * pi-intray owns generic session transport, discovery, and CLI flags; Bebop
 * owns project-local crew membership and role-based delivery only.
 */
export default function (pi: ExtensionAPI) {
	pi.registerFlag(CREW_SOCKET_FLAG, {
		description: "Select a crew socket path as the current crew identity (requires pi-intray)",
		type: "string",
	});

	const state = createSocketState();
	state.membershipRuntime = createMembershipRuntime({
		loadManifest: async (manifestPath) => {
			const context = state.context;
			if (!context) throw new Error("Session context is not ready");
			const projectRoot = path.resolve(path.dirname(manifestPath), "..", "..");
			return readTrustedCrewManifest(manifestPath, projectRoot, () => context.isProjectTrusted());
		},
	});

	registerMemberTool(pi, state);
	const persistMembership = (active: boolean, membership: import("./infra/membership-runtime.ts").Membership) => {
		pi.appendEntry(MEMBERSHIP_ENTRY_TYPE, membershipStateFromRuntime(membership, active));
	};
	const announceMembership = (message: string) => {
		pi.sendMessage({ customType: "crew-status", content: message, display: true }, { triggerTurn: false });
	};

	registerSessionControlCommand(pi, state, {
		disableControlServer: async () => {},
		membershipRuntime: state.membershipRuntime,
		getCrewManifestPathFromSocketPath,
		persistMembership,
		announceMembership,
		activateMembershipTool: () => activateMembershipTool(pi),
		deactivateMembershipTool: () => deactivateMembershipTool(pi),
	}, "crew");

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		state.context = ctx;
		// pi-intray owns this socket. Bebop uses its deterministic location only
		// when claiming a configured crew endpoint.
		state.socketPath = getSocketPath(ctx.sessionManager.getSessionId());
		const startupSocket = typeof pi.getFlag(CREW_SOCKET_FLAG) === "string"
			&& String(pi.getFlag(CREW_SOCKET_FLAG)).trim().length > 0;
		const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
		const persisted = getLatestMembershipState(branch);
		if (startupSocket) {
			const joined = await maybeHandleStartupSocketJoin(ctx, pi, { socket: CREW_SOCKET_FLAG }, state.membershipRuntime, state.socketPath);
			const membership = state.membershipRuntime.getMembership();
			if (joined && membership) {
				activateMembershipTool(pi);
				persistMembership(true, membership);
				announceMembership(`Crew joined ${membership.member.name} (${membership.member.role}) at ${membership.socketPath}`);
			}
			return;
		}
		await restorePersistedMembership({
			runtime: state.membershipRuntime,
			persisted,
			startupSocketSelected: false,
			globalSocketPath: state.socketPath,
			manifestPathForSocket: getCrewManifestPathFromSocketPath,
			announce: (message) => {
				activateMembershipTool(pi);
				announceMembership(message);
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
		const context = state.context;
		await releaseMembershipBeforeCleanup({
			hasMembership: Boolean(state.membershipRuntime?.getMembership()),
			leave: async () => state.membershipRuntime!.leave(),
			cleanup: async () => { deactivateMembershipTool(pi); },
			reportFailure: (message) => {
				if (context?.hasUI) context.ui.notify(message, "error");
				else console.error(message);
			},
		});
		state.context = null;
		state.socketPath = null;
	});
}
