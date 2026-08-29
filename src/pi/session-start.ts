import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSocketPath } from "../infra/intray-paths.ts";
import { getCrewManifestPathFromSocketPath } from "../infra/crew-manifest-store.ts";
import {
	ensureControlServer,
	reconcileMembershipTools,
	cancelCrewMemberIdleCommand,
	refreshIntrayStatus,
	refreshSessionAliases,
	activateMembershipTool,
} from "./control-runtime.ts";
import { getLatestMembershipState } from "./membership-context.ts";
import { restorePersistedMembership } from "./membership-lifecycle.ts";
import {
	maybeHandleStartupRoleJoin,
	maybeHandleStartupSocketJoin,
	resolveStartupCrewRole,
	startupRoleSelectionDescriptor,
	type StartupRoleSelection,
} from "./startup-send.ts";
import { ownershipFromMembership } from "./inbox-bridge-runtime.ts";
import type { ActionableErrorDescriptor } from "../domain/index.ts";
import { reportActionableError } from "./actionable-error-output.ts";
import type { createSocketState } from "./control-runtime.ts";
import { createInboxBridgeController } from "./inbox-bridge-runtime.ts";

const CREW_FLAG = "crew";
const CREW_SOCKET_FLAG = "crew-socket";
const CREW_ROLE_FLAG = "crew-role";

export async function handleSessionStart(
	pi: ExtensionAPI,
	state: ReturnType<typeof createSocketState>,
	ctx: ExtensionContext,
	deps: {
		readonly inboxBridge: ReturnType<typeof createInboxBridgeController>;
		readonly recoverInterrupts: () => Promise<void>;
		readonly refreshPresence: () => Promise<void>;
		readonly persistMembership: (active: boolean, membership: any) => void;
		readonly announceMembership: (message: string) => void;
		readonly restoreSessionName?: (entries: readonly unknown[]) => void;
		readonly syncSessionName?: (membership: any | null) => void | Promise<void>;
	},
): Promise<void> {
	// A new branch/session context replaces the previous command owner. Cancel
	// any human observation before restoring membership or replacing sockets.
	cancelCrewMemberIdleCommand(state, "session-replaced");
	const startup = await prepareStartupSelection(pi, ctx);
	if (!startup) return;
	const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
	deps.restoreSessionName?.(branch);
	const persisted = getLatestMembershipState(branch);
	await prepareSessionServer(pi, state, ctx, persisted, startup);
	if (startup.startupRole || startup.startupSocket) {
		await handleStartupJoin(
			pi,
			state,
			ctx,
			startup,
			deps.inboxBridge,
			deps.recoverInterrupts,
			deps.refreshPresence,
			deps.persistMembership,
			deps.announceMembership,
			deps.syncSessionName ?? (() => undefined),
		);
		return;
	}
	await restoreMembership(
		pi,
		state,
		ctx,
		persisted,
		deps.inboxBridge,
		deps.recoverInterrupts,
		deps.refreshPresence,
		deps.announceMembership,
		deps.syncSessionName ?? (() => undefined),
	);
}

type ExtensionState = ReturnType<typeof createSocketState>;

type StartupSelection = {
	readonly startupSocket: boolean;
	readonly startupRole: boolean;
	readonly rawCrewRole: unknown;
	readonly startupRoleSelection?: StartupRoleSelection;
};

function reportStartupError(ctx: ExtensionContext, descriptor: ActionableErrorDescriptor): void {
	reportActionableError(ctx, descriptor);
}

async function prepareStartupSelection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<StartupSelection | undefined> {
	const rawCrewRole = pi.getFlag(CREW_ROLE_FLAG);
	const startupSocket =
		typeof pi.getFlag(CREW_SOCKET_FLAG) === "string" && String(pi.getFlag(CREW_SOCKET_FLAG)).trim().length > 0;
	const startupRole = typeof rawCrewRole === "string" && rawCrewRole.trim().length > 0;
	if (rawCrewRole !== undefined && rawCrewRole !== false && (!startupRole || typeof rawCrewRole !== "string")) {
		reconcileMembershipTools(pi, false);
		reportStartupError(ctx, {
			code: "empty-role",
			operation: "Crew startup role join",
			reason: "the configured role is empty",
			recovery: ["provide a non-empty --crew-role value, then retry."],
			location: { kind: "flag", name: "--crew-role" },
		});
		return undefined;
	}
	if (startupSocket && startupRole) {
		reconcileMembershipTools(pi, false);
		reportStartupError(ctx, {
			code: "conflicting-startup-flags",
			operation: "Crew startup",
			reason: "--crew-role and --crew-socket cannot be used together",
			recovery: ["choose exactly one startup selection flag, then retry."],
		});
		return undefined;
	}
	let startupRoleSelection: StartupRoleSelection | undefined;
	if (startupRole) {
		try {
			startupRoleSelection = await resolveStartupCrewRole(String(rawCrewRole), ctx.cwd, ctx.isProjectTrusted());
		} catch {
			reconcileMembershipTools(pi, false);
			reportStartupError(ctx, {
				code: "unexpected-failure",
				operation: "Crew startup role join",
				reason: "the startup role selection could not be completed",
				recovery: ["verify Crew configuration and retry; if it repeats, report the operation and code."],
			});
			return undefined;
		}
		if (startupRoleSelection && "code" in startupRoleSelection) {
			reconcileMembershipTools(pi, false);
			reportStartupError(ctx, startupRoleSelectionDescriptor(startupRoleSelection));
			return undefined;
		}
	}
	return { startupSocket, startupRole, rawCrewRole, startupRoleSelection };
}

async function prepareSessionServer(
	pi: ExtensionAPI,
	state: ExtensionState,
	ctx: ExtensionContext,
	persisted: ReturnType<typeof getLatestMembershipState>,
	startup: StartupSelection,
): Promise<void> {
	const crewRequested = pi.getFlag(CREW_FLAG) === true || process.argv.includes(`--${CREW_FLAG}`);
	if (crewRequested || startup.startupSocket || startup.startupRole || persisted?.active === true) {
		await ensureControlServer(pi, state, ctx);
		return;
	}
	state.context = ctx;
	state.socketPath = getSocketPath(ctx.sessionManager.getSessionId());
	reconcileMembershipTools(pi, false);
}

async function handleStartupJoin(
	pi: ExtensionAPI,
	state: ExtensionState,
	ctx: ExtensionContext,
	startup: StartupSelection,
	inboxBridge: ReturnType<typeof createInboxBridgeController>,
	recoverInterrupts: () => Promise<void>,
	refreshPresence: () => void,
	persistMembership: (
		active: boolean,
		membership: NonNullable<ExtensionState["membershipRuntime"]>["getMembership"] extends () => infer M ? M : never,
	) => void,
	announceMembership: (message: string) => void,
	syncSessionName: (membership: any | null) => void | Promise<void>,
): Promise<void> {
	const joined = startup.startupRole
		? await maybeHandleStartupRoleJoin(
				ctx,
				pi,
				{ role: CREW_ROLE_FLAG },
				state.membershipRuntime,
				state.socketPath,
				async () => startup.startupRoleSelection!,
			)
		: await maybeHandleStartupSocketJoin(
				ctx,
				pi,
				{ socket: CREW_SOCKET_FLAG },
				state.membershipRuntime,
				state.socketPath,
			);
	const membership = state.membershipRuntime.getMembership();
	if (!joined || !membership) {
		await syncSessionName(null);
		reconcileMembershipTools(pi, false);
		return;
	}
	await syncSessionName(membership);
	activateMembershipTool(pi);
	refreshIntrayStatus(state);
	await refreshPresence();
	persistMembership(true, membership);
	announceMembership(`Crew joined ${membership.member.name} (${membership.member.role}) at ${membership.socketPath}`);
	inboxBridge.establish(ownershipFromMembership(membership));
	void inboxBridge.attemptOffer();
	void recoverInterrupts();
}

async function restoreMembership(
	pi: ExtensionAPI,
	state: ExtensionState,
	ctx: ExtensionContext,
	persisted: ReturnType<typeof getLatestMembershipState>,
	inboxBridge: ReturnType<typeof createInboxBridgeController>,
	recoverInterrupts: () => Promise<void>,
	refreshPresence: () => void,
	announceMembership: (message: string) => void,
	syncSessionName: (membership: any | null) => void | Promise<void>,
): Promise<void> {
	await restorePersistedMembership({
		runtime: state.membershipRuntime,
		persisted,
		startupSocketSelected: false,
		globalSocketPath: state.socketPath,
		manifestPathForSocket: getCrewManifestPathFromSocketPath,
		announce: async (message) => {
			activateMembershipTool(pi);
			refreshIntrayStatus(state);
			await refreshPresence();
			announceMembership(message);
			const membership = state.membershipRuntime?.getMembership();
			if (membership) {
				await syncSessionName(membership);
				inboxBridge.establish(ownershipFromMembership(membership));
				void inboxBridge.attemptOffer();
				void recoverInterrupts();
			}
		},
		reportFailure: () =>
			reportStartupError(ctx, {
				code: "unexpected-failure",
				operation: "Crew Membership restore",
				reason: "persisted Crew Membership could not be restored",
				recovery: ["verify the persisted Crew state and retry; if it repeats, report the operation and code."],
			}),
	});
	if (!state.membershipRuntime?.getMembership()) {
		await syncSessionName(null);
		reconcileMembershipTools(pi, false);
	}
}
