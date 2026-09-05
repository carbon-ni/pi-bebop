import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SocketState } from "./control-runtime.ts";
import {
	activateMembershipTool,
	deactivateMembershipTool,
	disableControlServer,
	emitIdleSettled,
	emitTurnEnd,
	ensureControlServer,
	reconcileMembershipTools,
	refreshIntrayStatus,
} from "./control-runtime.ts";
import { readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import { getCrewManifestPathFromSocketPath } from "../infra/crew-manifest-store.ts";
import { createMembershipRuntime, type Membership } from "../infra/membership-runtime.ts";
import { getSocketPath } from "../infra/intray-paths.ts";
import {
	appendMembershipContext,
	appendGuestMembershipContext,
	getLatestMembershipState,
	MEMBERSHIP_ENTRY_TYPE,
	getLatestGuestMembershipRecords,
	membershipStateFromRuntime,
} from "./membership-context.ts";
import { releaseMembershipBeforeCleanup, restorePersistedMembership } from "./membership-lifecycle.ts";
import {
	maybeHandleStartupRoleJoin,
	maybeHandleStartupSocketJoin,
	maybeHandleStartupGuestJoins,
	resolveStartupCrewRole,
	startupRoleSelectionError,
	type StartupRoleSelection,
} from "./startup-send.ts";
import { ownershipFromMembership } from "./inbox-bridge-runtime.ts";
import type { InboxBridgeController } from "../application/inbox-bridge.ts";

export const CREW_FLAG = "crew";
export const CREW_SOCKET_FLAG = "crew-socket";
export const CREW_ROLE_FLAG = "crew-role";
export const GUEST_AS_FLAG = "guest-as";
export const GUEST_JOIN_FLAG = "guest-join";

export interface SessionLifecycleDeps {
	readonly refreshGuestAdmission: () => void;
	readonly ensureGuestMessagingTools: () => void;
	readonly inboxBridge: InboxBridgeController;
	readonly recoverInterrupts: () => Promise<void>;
	readonly refreshPresence: () => Promise<void>;
	readonly stopPresence: () => Promise<void>;
}

/** Durable TUI-only membership entries and human-visible status lines. */
export function createMembershipRecording(pi: ExtensionAPI): {
	persistMembership: (active: boolean, membership: Membership) => void;
	announceMembership: (message: string) => void;
} {
	const persistMembership = (active: boolean, membership: Membership) => {
		pi.appendEntry(MEMBERSHIP_ENTRY_TYPE, membershipStateFromRuntime(membership, active));
	};
	const announceMembership = (message: string) => {
		// Durable TUI-only custom entry: human-visible, never part of LLM context.
		pi.appendEntry("crew-status", { content: message });
	};
	return { persistMembership, announceMembership };
}

/** Wires the membership runtime onto shared socket state (manifest reads via session trust). */
export function wireMembershipRuntime(state: SocketState): void {
	state.membershipRuntime = createMembershipRuntime({
		loadManifest: async (manifestPath) => {
			const context = state.context;
			if (!context) throw new Error("Session context is not ready");
			const projectRoot = path.resolve(path.dirname(manifestPath), "..", "..");
			return readTrustedCrewManifest(manifestPath, projectRoot, () => context.isProjectTrusted());
		},
	});
}

/**
 * Pi session lifecycle handlers (session_start, before_agent_start,
 * session_shutdown, turn_end, agent_settled, compaction_end). Registration
 * only — every decision stays in the moved handler bodies, unchanged.
 */
export function registerSessionLifecycle(pi: ExtensionAPI, state: SocketState, deps: SessionLifecycleDeps): void {
	const { inboxBridge, recoverInterrupts } = deps;
	const { persistMembership, announceMembership } = createMembershipRecording(pi);

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const rawGuestName = pi.getFlag(GUEST_AS_FLAG);
		const guestTargets = (() => {
			const configured = pi.getFlag(GUEST_JOIN_FLAG);
			if (Array.isArray(configured))
				return configured.filter((value): value is string => typeof value === "string");
			const values: string[] = [];
			for (let index = 0; index < process.argv.length; index += 1) {
				const value = process.argv[index]!;
				if (value.startsWith(`--${GUEST_JOIN_FLAG}=`)) values.push(value.slice(GUEST_JOIN_FLAG.length + 3));
				else if (value === `--${GUEST_JOIN_FLAG}` && process.argv[index + 1])
					values.push(process.argv[++index]!);
			}
			return values;
		})();
		const guestRequested =
			(typeof rawGuestName === "string" && rawGuestName.trim().length > 0) ||
			guestTargets.length > 0 ||
			process.argv.some((value) => value === `--${GUEST_AS_FLAG}` || value.startsWith(`--${GUEST_AS_FLAG}=`));
		const startupSocket =
			typeof pi.getFlag(CREW_SOCKET_FLAG) === "string" && String(pi.getFlag(CREW_SOCKET_FLAG)).trim().length > 0;
		const rawCrewRole = pi.getFlag(CREW_ROLE_FLAG);
		const startupRole = typeof rawCrewRole === "string" && rawCrewRole.trim().length > 0;
		if (guestRequested && (startupRole || startupSocket || pi.getFlag(CREW_FLAG) === true)) {
			reconcileMembershipTools(pi, false);
			const message = "Guest startup flags cannot be combined with Member crew membership flags";
			ctx.hasUI ? ctx.ui.notify(message, "error") : console.error(message);
			return;
		}
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
		const persistedGuests = getLatestGuestMembershipRecords(branch);
		const crewRequested = pi.getFlag(CREW_FLAG) === true || process.argv.includes(`--${CREW_FLAG}`);
		if (guestRequested) {
			if (persisted?.active === true) {
				reconcileMembershipTools(pi, false);
				const message = "Guest startup flags cannot resume a Member crew membership";
				ctx.hasUI ? ctx.ui.notify(message, "error") : console.error(message);
				return;
			}
			await ensureControlServer(pi, state, ctx);
			state.guestMembershipRuntime?.restore(persistedGuests);
			deps.refreshGuestAdmission();
			await maybeHandleStartupGuestJoins(ctx, pi, state.guestMembershipRuntime!, state.socketPath!);
			deps.ensureGuestMessagingTools();
			reconcileMembershipTools(pi, false);
			return;
		}
		if (crewRequested || startupSocket || startupRole || persisted?.active === true || persistedGuests.length > 0) {
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
				deps.refreshGuestAdmission();
				activateMembershipTool(pi);
				refreshIntrayStatus(state);
				await deps.refreshPresence();
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
		state.guestMembershipRuntime?.restore(persistedGuests);
		deps.ensureGuestMessagingTools();
		deps.refreshGuestAdmission();
		await restorePersistedMembership({
			runtime: state.membershipRuntime,
			persisted,
			startupSocketSelected: false,
			globalSocketPath: state.socketPath,
			manifestPathForSocket: getCrewManifestPathFromSocketPath,
			announce: async (message) => {
				deps.refreshGuestAdmission();
				activateMembershipTool(pi);
				refreshIntrayStatus(state);
				await deps.refreshPresence();
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
		if (membership) return { systemPrompt: appendMembershipContext(event.systemPrompt, membership) };
		const guestRuntime = state.guestMembershipRuntime;
		if (guestRuntime?.list().some((row) => row.status === "approved"))
			return { systemPrompt: appendGuestMembershipContext(event.systemPrompt, guestRuntime) };
	});

	pi.on("session_shutdown", async () => {
		inboxBridge.invalidate();
		const context = state.context;
		await releaseMembershipBeforeCleanup({
			hasMembership: Boolean(state.membershipRuntime?.getMembership()),
			leave: async () => state.membershipRuntime!.leave(),
			onReleased: async () => {
				await deps.stopPresence();
			},
			cleanup: async () => {
				await deps.stopPresence();
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
