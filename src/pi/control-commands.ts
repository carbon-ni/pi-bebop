import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatCrewRoster,
	parseSessionControlAction,
	parseGuestControlAction,
	type SessionControlAction,
} from "../domain/index.ts";
import { probeMemberEndpoint } from "../infra/member-endpoint.ts";
import { selectCrewSocketPath } from "../infra/crew-manifest-store.ts";
import type { MembershipRuntime, Membership } from "../infra/membership-runtime.ts";
import type { GuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import type { GuestAdmissionRuntime } from "../infra/guest-admission-runtime.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { isGuestJoinResult, type GuestJoinCommand } from "../domain/index.ts";
import { deriveIntrayStatus, ensureControlServer, type SocketState } from "./control-runtime.ts";
import { releaseMembershipBeforeCleanup } from "./membership-lifecycle.ts";
import { formatInboxStatus, type InboxBridgeController } from "../application/inbox-bridge.ts";
import { ownershipFromMembership } from "./inbox-bridge-runtime.ts";

export type ControlCommandDeps = {
	ensureControlServer?: typeof ensureControlServer;
	disableControlServer(state: SocketState, ctx: ExtensionContext | null): Promise<void>;
	probeMemberEndpoint?: (socketPath: string) => Promise<boolean>;
	membershipRuntime?: MembershipRuntime;
	persistMembership?: (active: boolean, membership: Membership) => void;
	announceMembership?: (message: string) => void;
	activateMembershipTool?: () => void;
	deactivateMembershipTool?: () => void;
	refreshStatus?: () => void;
	refreshPresence?: () => void | Promise<void>;
	refreshGuestAdmission?: () => void;
	stopPresence?: () => void | Promise<void>;
	inboxBridge?: InboxBridgeController | null;
	guestMembershipRuntime?: GuestMembershipRuntime;
	guestAdmissionRuntime?: GuestAdmissionRuntime;
	guestIdentity?: () => string;
	sendGuestJoin?: typeof sendRpcCommand;
};

const ACTIONS: SessionControlAction[] = ["join", "leave", "members", "status", "stop", "inbox"];
const GUEST_ACTIONS = ["join", "crews", "leave"] as const;

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function renderStatus(state: SocketState): string {
	const membership = state.membershipRuntime?.getMembership();
	const status = deriveIntrayStatus(Boolean(state.server), Boolean(membership));
	const crew = membership
		? `\nCrew: ${membership.manifestPath}\nMember: ${membership.member.name} (${membership.member.role})\nEndpoint: ${membership.socketPath}`
		: "";
	return `Crew ${status}${crew}`;
}

export async function renderCrewRoster(
	state: SocketState,
	dependencies: Pick<ControlCommandDeps, "probeMemberEndpoint"> = {},
): Promise<string> {
	const membership = state.membershipRuntime?.getMembership();
	if (!membership) return "Crew not joined. Use /crew join <socket>.";
	const probe = dependencies.probeMemberEndpoint ?? probeMemberEndpoint;
	const current = membership.member;
	const rows = await Promise.all(
		membership.manifest.members.map(async (member) => {
			if (
				member.name === current.name &&
				member.role === current.role &&
				member.socketPath === current.socketPath
			)
				return { member, status: "current" as const };
			try {
				return {
					member,
					status: (await probe(member.socketPath)) ? ("online" as const) : ("offline" as const),
				};
			} catch {
				return { member, status: "offline" as const };
			}
		}),
	);
	return formatCrewRoster(membership.manifestPath, rows);
}

export function registerSessionControlCommand(
	pi: ExtensionAPI,
	state: SocketState,
	deps: ControlCommandDeps,
	commandName = "crew",
): void {
	pi.registerCommand(commandName, {
		description: "Join, inspect crew members, leave, show status, or stop Bebop",
		getArgumentCompletions: (prefix) => {
			const matches = ACTIONS.filter((action) => action.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const membership = deps.membershipRuntime ?? state.membershipRuntime;
			const parsed = parseSessionControlAction(args);
			if (!parsed.action) {
				notify(ctx, parsed.error ?? "Invalid crew action", "error");
				return;
			}

			switch (parsed.action) {
				case "join": {
					if (deps.ensureControlServer) await deps.ensureControlServer(pi, state, ctx);
					if (!ctx.isProjectTrusted()) {
						notify(ctx, "Crew join failed: project is not trusted", "error");
						return;
					}
					if (!membership || !state.socketPath) {
						notify(ctx, "Crew join failed: membership runtime is unavailable", "error");
						return;
					}
					state.membershipRuntime = membership;
					const selection = selectCrewSocketPath(parsed.target!, ctx.cwd);
					if (!selection) {
						notify(
							ctx,
							`Crew join failed: untrusted crew manifest path for socket ${parsed.target!}; use .pi/bebop or .pi/crew sockets`,
							"error",
						);
						return;
					}
					const socketPath = selection.socketPath;
					const manifestPath = selection.manifestPath;
					const result = await membership.join({
						manifestPath,
						socketPath,
						globalSocketPath: state.socketPath,
					});
					if ("error" in result) {
						notify(ctx, `Crew join failed: ${result.error.message}`, "error");
						return;
					}
					const joinedMessage = `Crew joined ${result.membership.member.name} (${result.membership.member.role}) at ${result.membership.socketPath}`;
					deps.persistMembership?.(true, result.membership);
					deps.refreshGuestAdmission?.();
					deps.activateMembershipTool?.();
					deps.refreshStatus?.();
					await deps.refreshPresence?.();
					deps.announceMembership?.(joinedMessage);
					deps.inboxBridge?.establish(ownershipFromMembership(result.membership));
					void deps.inboxBridge?.attemptOffer();
					notify(ctx, joinedMessage);
					return;
				}
				case "leave": {
					if (!membership) {
						notify(ctx, "Crew leave failed: membership runtime is unavailable", "error");
						return;
					}
					const previousMembership = membership.getMembership();
					const result = await membership.leave();
					if ("error" in result) notify(ctx, `Crew leave failed: ${result.error.message}`, "error");
					else {
						if (result.left) {
							if (previousMembership) deps.persistMembership?.(false, previousMembership);
							deps.refreshGuestAdmission?.();
							deps.deactivateMembershipTool?.();
							deps.refreshStatus?.();
							await deps.stopPresence?.();
							deps.announceMembership?.("Crew membership released");
							deps.inboxBridge?.invalidate();
						}
						notify(ctx, result.left ? "Crew membership released" : "Crew not joined");
					}
					return;
				}
				case "guests": {
					const admission = state.guestAdmissionRuntime ?? deps.guestAdmissionRuntime;
					if (!admission) {
						pi.appendEntry("crew-guests", { content: "Guest admission is disabled for this Crew." });
						return;
					}
					const rows = admission.list();
					const content =
						rows.length === 0
							? "Crew Guests: none"
							: [
									"Crew Guests:",
									...rows.map((row) =>
										row.status === "pending"
											? `- pending ${row.requestId}: ${row.guestName}`
											: `- ${row.status} ${row.guestName}${row.approvedBy ? ` (approved by ${row.approvedBy})` : ""}`,
									),
								].join("\\n");
					pi.appendEntry("crew-guests", { content });
					return;
				}
				case "guest": {
					const admission = state.guestAdmissionRuntime ?? deps.guestAdmissionRuntime;
					const currentMembership = membership?.getMembership();
					if (!admission || !currentMembership) {
						notify(ctx, "Guest admission is unavailable", "error");
						return;
					}
					const approver = currentMembership.member.name;
					const result =
						parsed.target === "approve"
							? admission.approve(parsed.value, approver)
							: parsed.target === "deny"
								? admission.deny(parsed.value, approver)
								: admission.remove(parsed.value, approver);
					if ("code" in result) notify(ctx, `Guest ${parsed.target} failed: ${result.code}`, "error");
					else notify(ctx, `Guest ${parsed.target} completed`);
					return;
				}
				case "members": {
					const content = await renderCrewRoster(state, deps);
					// Durable TUI-only custom entry: human-visible, never in LLM context.
					pi.appendEntry("crew-roster", { content });
					return;
				}
				case "status":
					pi.appendEntry("crew-status", { content: renderStatus(state) });
					return;
				case "inbox": {
					const bridge = deps.inboxBridge;
					const sub = parsed.target ?? "";
					if (!bridge) {
						notify(ctx, "Inbox bridge unavailable", "error");
						return;
					}
					if (sub === "status") {
						const status = await bridge.status();
						pi.appendEntry("crew-inbox", { content: formatInboxStatus(status) });
						return;
					}
					if (sub === "pause") {
						bridge.setPaused(true);
						notify(ctx, "Inbox automatic offering paused");
						return;
					}
					if (sub === "resume") {
						bridge.setPaused(false);
						notify(ctx, "Inbox automatic offering resumed");
						return;
					}
					if (sub.startsWith("cancel ")) {
						const itemId = sub.slice("cancel ".length);
						const outcome = await bridge.cancel(itemId);
						if (outcome.removed === true) notify(ctx, `Inbox item cancelled: ${outcome.itemId}`);
						else if (outcome.reason === "not-pending")
							notify(ctx, `Inbox item ${itemId} is not pending (already handed to session)`, "warning");
						else notify(ctx, `Inbox item not found: ${itemId}`, "warning");
						return;
					}
					notify(ctx, `Unknown inbox action: ${sub}`, "error");
					return;
				}
				case "stop": {
					const previousMembership = membership?.getMembership();
					await releaseMembershipBeforeCleanup({
						hasMembership: Boolean(previousMembership),
						leave: async () => membership!.leave(),
						cleanup: () => deps.disableControlServer(state, ctx),
						onReleased: async () => {
							if (previousMembership) deps.persistMembership?.(false, previousMembership);
							deps.deactivateMembershipTool?.();
							deps.refreshStatus?.();
							await deps.stopPresence?.();
							deps.announceMembership?.("Crew membership released");
							deps.inboxBridge?.invalidate();
						},
						reportFailure: (message) => notify(ctx, message, "warning"),
					});
					notify(ctx, "Bebop stopped");
					return;
				}
			}
		},
	});
}
