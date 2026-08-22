import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSessionControlAction, type SessionControlAction } from "../domain/index.ts";
import { getLiveSessions, type LiveSessionInfo } from "../infra/control-store.ts";
import { getCrewManifestPathFromSocketPath, selectCrewSocketPath } from "../infra/crew-manifest-store.ts";
import { getSocketPath } from "../infra/intray-paths.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import type { MembershipRuntime, Membership } from "../infra/membership-runtime.ts";
import { deriveIntrayStatus, ensureControlServer, type SocketState } from "./control-runtime.ts";
import { releaseMembershipBeforeCleanup } from "./membership-lifecycle.ts";

export type ControlCommandDeps = {
	ensureControlServer?: typeof ensureControlServer;
	disableControlServer(state: SocketState, ctx: ExtensionContext | null): Promise<void>;
	getLiveSessions?: typeof getLiveSessions;
	sendRpcCommand?: typeof sendRpcCommand;
	getSocketPath?: typeof getSocketPath;
	getCrewManifestPathFromSocketPath?: typeof getCrewManifestPathFromSocketPath;
	membershipRuntime?: MembershipRuntime;
	persistMembership?: (active: boolean, membership: Membership) => void;
	announceMembership?: (message: string) => void;
	activateMembershipTool?: () => void;
	deactivateMembershipTool?: () => void;
	refreshStatus?: () => void;
};

const ACTIONS: SessionControlAction[] = ["join", "leave", "list", "status", "stop"];

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function renderStatus(state: SocketState): string {
	const membership = state.membershipRuntime?.getMembership();
	const status = deriveIntrayStatus(Boolean(state.server), Boolean(membership));
	const crew = membership
		? `\nCrew: ${membership.manifestPath}\nMember: ${membership.member.name} (${membership.member.role})\nEndpoint: ${membership.socketPath}`
		: "";
	return `Intray ${status}${crew}`;
}

async function getSessionStatus(
	session: LiveSessionInfo,
	currentSessionId: string,
	state: SocketState,
	sendRpc: typeof sendRpcCommand,
	resolveSocketPath: typeof getSocketPath,
): Promise<string> {
	if (session.sessionId === currentSessionId) return deriveIntrayStatus(Boolean(state.server), Boolean(state.membershipRuntime?.getMembership()));
	try {
		const result = await sendRpc(resolveSocketPath(session.sessionId), { type: "status" }, { timeout: 500 });
		if (!result.response.success) return "online";
		const data = result.response.data as { status?: string } | undefined;
		return data?.status ?? "online";
	} catch {
		return "online";
	}
}

export async function renderSessionList(
	state: SocketState,
	ctx: ExtensionContext,
	dependencies: Pick<ControlCommandDeps, "getLiveSessions" | "sendRpcCommand" | "getSocketPath"> = {},
): Promise<string> {
	const listSessions = dependencies.getLiveSessions ?? getLiveSessions;
	const sendRpc = dependencies.sendRpcCommand ?? sendRpcCommand;
	const resolveSocketPath = dependencies.getSocketPath ?? getSocketPath;
	const sessions = await listSessions();
	const currentSessionId = ctx.sessionManager.getSessionId();
	const rows = await Promise.all(sessions.map(async (session) => {
		const aliases = session.aliases.length > 0 ? ` (${session.aliases.join(", ")})` : "";
		const current = session.sessionId === currentSessionId ? " (current)" : "";
		const status = await getSessionStatus(session, currentSessionId, state, sendRpc, resolveSocketPath);
		return `- ${session.sessionId}${aliases} — ${status}${current}`;
	}));
	return rows.length > 0 ? `Intray sessions:\n${rows.join("\n")}` : "No live intray sessions.";
}

export function registerSessionControlCommand(pi: ExtensionAPI, state: SocketState, deps: ControlCommandDeps, commandName = "crew"): void {
	pi.registerCommand(commandName, {
		description: "Join, leave, list, status, or stop intray",
		getArgumentCompletions: (prefix) => {
			const matches = ACTIONS.filter((action) => action.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const membership = deps.membershipRuntime ?? state.membershipRuntime;
			const parsed = parseSessionControlAction(args);
			if (!parsed.action) {
				notify(ctx, parsed.error ?? "Invalid intray action", "error");
				return;
			}

			switch (parsed.action) {
				case "join": {
					if (deps.ensureControlServer) await deps.ensureControlServer(pi, state, ctx);
					if (!ctx.isProjectTrusted()) {
						notify(ctx, "Intray join failed: project is not trusted", "error");
						return;
					}
					if (!membership || !state.socketPath) {
						notify(ctx, "Intray join failed: membership runtime is unavailable", "error");
						return;
					}
					state.membershipRuntime = membership;
					const selection = selectCrewSocketPath(parsed.target!, ctx.cwd);
					if (!selection) {
						notify(ctx, `Intray join failed: untrusted crew manifest path for socket ${parsed.target!}; use .pi/bebop or .pi/crew sockets`, "error");
						return;
					}
					const socketPath = selection.socketPath;
					const manifestPath = (deps.getCrewManifestPathFromSocketPath ?? getCrewManifestPathFromSocketPath)(socketPath);
					const result = await membership.join({ manifestPath, socketPath, globalSocketPath: state.socketPath });
					if ("error" in result) {
						notify(ctx, `Intray join failed: ${result.error.message}`, "error");
						return;
					}
					const joinedMessage = `Intray joined ${result.membership.member.name} (${result.membership.member.role}) at ${result.membership.socketPath}`;
					deps.persistMembership?.(true, result.membership);
					deps.activateMembershipTool?.();
					deps.refreshStatus?.();
					deps.announceMembership?.(joinedMessage);
					notify(ctx, joinedMessage);
					return;
				}
				case "leave": {
					if (!membership) {
						notify(ctx, "Intray leave failed: membership runtime is unavailable", "error");
						return;
					}
					const previousMembership = membership.getMembership();
					const result = await membership.leave();
					if ("error" in result) notify(ctx, `Intray leave failed: ${result.error.message}`, "error");
					else {
						if (result.left) {
							if (previousMembership) deps.persistMembership?.(false, previousMembership);
							deps.deactivateMembershipTool?.();
							deps.refreshStatus?.();
							deps.announceMembership?.("Intray crew membership released");
						}
						notify(ctx, result.left ? "Intray crew membership released" : "Intray not joined");
					}
					return;
				}
				case "list": {
					const content = await renderSessionList(state, ctx, deps);
					pi.sendMessage({ customType: "intray-status", content, display: true }, { triggerTurn: false });
					return;
				}
				case "status":
					pi.sendMessage({ customType: "intray-status", content: renderStatus(state), display: true }, { triggerTurn: false });
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
							deps.announceMembership?.("Intray crew membership released");
						},
						reportFailure: (message) => notify(ctx, message, "warning"),
					});
					notify(ctx, "Intray stopped");
					return;
				}
			}
		},
	});
}
