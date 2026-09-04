import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isGuestJoinResult, parseGuestControlAction, type GuestJoinCommand } from "../domain/index.ts";
import type { GuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import type { SocketState } from "./control-runtime.ts";

const GUEST_ACTIONS = ["join", "crews", "leave"] as const;

export interface GuestControlCommandDeps {
	readonly ensureControlServer: (pi: ExtensionAPI, state: SocketState, ctx: ExtensionContext) => Promise<void>;
	readonly guestMembershipRuntime: GuestMembershipRuntime;
	readonly guestIdentity: (ctx: ExtensionContext) => string;
	readonly sendJoin?: typeof sendRpcCommand;
	readonly sendLeave?: typeof sendRpcCommand;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function formatGuestCrews(runtime: GuestMembershipRuntime): string {
	const rows = runtime.list();
	if (rows.length === 0) return "Guest is not joined to any crew.";
	return [
		"Guest crews:",
		...rows.map((row) =>
			row.status === "pending"
				? `- ${row.crew.id} — ${row.crew.displayName} — ${row.guestName} — pending (${row.requestId})`
				: `- ${row.crew.id} — ${row.crew.displayName} — ${row.guestName} — approved (${row.approvedBy})`,
		),
	].join("\n");
}

/** Registers Guest-only control operations. They never enter the model turn. */
export function registerGuestControlCommand(
	pi: ExtensionAPI,
	state: SocketState,
	deps: GuestControlCommandDeps,
	commandName = "guest",
): void {
	pi.registerCommand(commandName, {
		description: "Request Guest admission, list Guest crews, or leave a Crew",
		getArgumentCompletions: (prefix) => {
			const matches = GUEST_ACTIONS.filter((action) => action.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseGuestControlAction(args);
			if ("error" in parsed) {
				notify(ctx, parsed.error, "error");
				return;
			}
			if (parsed.action === "crews") {
				pi.appendEntry("guest-crews", { content: formatGuestCrews(deps.guestMembershipRuntime) });
				return;
			}
			if (parsed.action === "leave") {
				const membership = deps.guestMembershipRuntime.list().find((row) => row.crew.id === parsed.target);
				if (membership && state.socketPath) {
					try {
						const remote = await (deps.sendLeave ?? sendRpcCommand)(
							deps.guestMembershipRuntime.getMemberSocket(parsed.target) ?? parsed.target,
							{
								type: "guest_leave",
								guestIdentity: membership.guestIdentity,
								crewId: membership.crew.id,
								callbackEndpoint: state.socketPath,
							},
							{ timeout: 5000 },
						);
						if (!remote.response.success) {
							notify(ctx, `Guest leave failed: ${remote.response.error ?? "remote rejection"}`, "error");
							return;
						}
					} catch (error) {
						notify(
							ctx,
							`Guest leave failed: ${error instanceof Error ? error.message : "transport error"}`,
							"error",
						);
						return;
					}
				}
				const result = await deps.guestMembershipRuntime.leave(parsed.target);
				if ("code" in result) notify(ctx, `Guest leave failed: ${result.code}`, "error");
				else
					notify(
						ctx,
						result.left
							? `Guest left crew ${parsed.target}`
							: `Guest is not joined to crew ${parsed.target}`,
					);
				return;
			}
			if (!ctx.isProjectTrusted()) {
				notify(ctx, "Guest join failed: project is not trusted", "error");
				return;
			}
			await deps.ensureControlServer(pi, state, ctx);
			if (!state.socketPath) {
				notify(ctx, "Guest join failed: callback endpoint is unavailable", "error");
				return;
			}
			const command: GuestJoinCommand = {
				type: "guest_join",
				guestIdentity: deps.guestIdentity(ctx),
				guestName: parsed.guestName,
				callbackEndpoint: state.socketPath,
			};
			try {
				const result = await (deps.sendJoin ?? sendRpcCommand)(parsed.target, command, { timeout: 5000 });
				if (!result.response.success || !isGuestJoinResult(result.response.data)) {
					notify(ctx, `Guest join failed: ${result.response.error ?? "invalid admission response"}`, "error");
					return;
				}
				const input = {
					crew: result.response.data.crew,
					guestName: parsed.guestName,
					memberSocket: parsed.target,
					submittedByMember: "member",
				};
				const tracked = deps.guestMembershipRuntime.track(
					input,
					result.response.data.requestId,
					result.response.data.status,
				);
				if (!tracked.ok) {
					notify(ctx, "Guest join failed: response could not be bound to this session", "error");
					return;
				}
				notify(
					ctx,
					tracked.status === "pending"
						? `Guest admission pending ${tracked.requestId} for ${result.response.data.crew.displayName}`
						: `Guest admitted to ${result.response.data.crew.displayName}`,
				);
			} catch (error) {
				notify(
					ctx,
					`Guest join failed: ${error instanceof Error ? error.message : "transport error"}`,
					"error",
				);
			}
		},
	});
}

export { formatGuestCrews };
