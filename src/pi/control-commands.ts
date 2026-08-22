import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatCrewRoster, parseSessionControlAction, type SessionControlAction } from "../domain/index.ts";
import { probeMemberEndpoint } from "../infra/member-endpoint.ts";
import { selectCrewSocketPath } from "../infra/crew-manifest-store.ts";
import type { MembershipRuntime, Membership } from "../infra/membership-runtime.ts";
import { deriveIntrayStatus, ensureControlServer, type SocketState } from "./control-runtime.ts";
import { releaseMembershipBeforeCleanup } from "./membership-lifecycle.ts";

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
};

const ACTIONS: SessionControlAction[] = ["join", "leave", "members", "status", "stop"];

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
					deps.activateMembershipTool?.();
					deps.refreshStatus?.();
					deps.announceMembership?.(joinedMessage);
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
							deps.deactivateMembershipTool?.();
							deps.refreshStatus?.();
							deps.announceMembership?.("Crew membership released");
						}
						notify(ctx, result.left ? "Crew membership released" : "Crew not joined");
					}
					return;
				}
				case "members": {
					const content = await renderCrewRoster(state, deps);
					pi.sendMessage({ customType: "crew-roster", content, display: true }, { triggerTurn: false });
					return;
				}
				case "status":
					pi.sendMessage(
						{ customType: "crew-status", content: renderStatus(state), display: true },
						{ triggerTurn: false },
					);
					return;
				case "stop": {
					const previousMembership = membership?.getMembership();
					await releaseMembershipBeforeCleanup({
						hasMembership: Boolean(previousMembership),
						leave: async () => membership!.leave(),
						cleanup: () => deps.disableControlServer(state, ctx),
						onReleased: () => {
							if (previousMembership) deps.persistMembership?.(false, previousMembership);
							deps.deactivateMembershipTool?.();
							deps.refreshStatus?.();
							deps.announceMembership?.("Crew membership released");
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
