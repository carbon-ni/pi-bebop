import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatCrewRoster,
	parseSessionControlAction,
	parseCrewBoardCommand,
	normalizeBoardKinds,
	type SessionControlAction,
	type CrewPostKind,
	presentActionableError,
} from "../domain/index.ts";
import { probeMemberEndpoint } from "../infra/member-endpoint.ts";
import { selectCrewSocketPath } from "../infra/crew-manifest-store.ts";
import type { MembershipRuntime, Membership } from "../infra/membership-runtime.ts";
import { deriveIntrayStatus, ensureControlServer, type SocketState } from "./control-runtime.ts";
import { releaseMembershipBeforeCleanup } from "./membership-lifecycle.ts";
import { formatInboxStatus, type InboxBridgeController } from "../application/inbox-bridge.ts";
import { ownershipFromMembership } from "./inbox-bridge-runtime.ts";
import { leaveCrewPost, readCrewBoard, type CrewBoardStoreDependencies } from "../application/crew-board.ts";
import type { BoardReadResult } from "../domain/index.ts";

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
	stopPresence?: () => void | Promise<void>;
	activateAgreementRevision?: (
		revisionId: string,
		ctx: ExtensionContext,
	) => Promise<{
		readonly revisionId: string;
		readonly priorRevisionId: string;
		readonly disposition: "activated" | "unchanged";
		readonly notices: readonly { readonly member: string; readonly status: string; readonly message?: string }[];
	}>;
	inboxBridge?: InboxBridgeController | null;
	crewBoard?: CrewBoardStoreDependencies;
	crewBoardOperationId?: (args: string) => string;
	crewBoardNow?: () => number;
};

const ACTIONS: SessionControlAction[] = [
	"join",
	"leave",
	"members",
	"status",
	"stop",
	"agreements",
	"inbox",
	"board",
	"post",
];

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function renderStatus(state: SocketState): string {
	const membership = state.membershipRuntime?.getMembership();
	const status = deriveIntrayStatus(Boolean(state.server), Boolean(membership));
	const crew = membership
		? `\nCrew: ${membership.manifestPath}${membership.manifest.name === undefined ? "" : `\nName: ${membership.manifest.name}`}\nMember: ${membership.member.name} (${membership.member.role})\nEndpoint: ${membership.socketPath}`
		: "";
	return `Crew ${status}${crew}`;
}

let boardOperationSequence = 0;

function renderCrewBoard(result: BoardReadResult, requestedKinds: readonly CrewPostKind[] | undefined): string {
	const lines = [
		`Crew Board: returned ${result.posts.length} Post${result.posts.length === 1 ? "" : "s"}; hasMore=${result.hasMore}; corruptCount=${result.corruptCount}; quarantinedThisRead=${result.quarantinedThisRead}; corruptCountTruncated=${result.corruptCountTruncated}; contentTruncated=false`,
	];
	for (const post of result.posts) {
		const message = post.message;
		const references = post.references.length ? ` references=${JSON.stringify(post.references)}` : "";
		const link = post.link ? ` link=${JSON.stringify(post.link)}` : "";
		const redactions = post.redactions.length ? ` redactions=${JSON.stringify(post.redactions)}` : "";
		lines.push(
			`#${post.sequence} ${post.id} [${post.kind}] ${post.author.name} (${post.author.role}) createdAt ${post.createdAt}: ${message}${references}${link}${redactions}`,
		);
	}
	if (result.nextCursor) {
		const filters = normalizeBoardKinds(requestedKinds)
			.map((kind) => `--kind ${kind}`)
			.join(" ");
		lines.push(`Continue: /crew board${filters ? ` ${filters}` : ""} --after ${result.nextCursor}`);
	}
	return lines.join("\n");
}

function renderCrewPostConfirmation(result: Awaited<ReturnType<typeof leaveCrewPost>>): string {
	const post = result.post;
	const prefix = result.alreadyPersisted ? "Crew Post already persisted" : "Crew Post persisted";
	return `${prefix}: ${post.id} (#${post.sequence}, ${post.kind}, ${post.author.name} (${post.author.role}), createdAt ${post.createdAt})`;
}

function boardDependencies(
	deps: ControlCommandDeps,
	state: SocketState,
	membership: MembershipRuntime | undefined,
): CrewBoardStoreDependencies | null {
	if (!deps.crewBoard) return null;
	return {
		...deps.crewBoard,
		getCurrentMembership:
			deps.crewBoard.getCurrentMembership ??
			(() => membership?.getMembership() ?? state.membershipRuntime?.getMembership() ?? null),
	};
}

const BOARD_COMMAND_CODES = new Set([
	"not-joined",
	"untrusted-project",
	"untrusted-path",
	"unsupported-layout",
	"stale-membership",
	"invalid-request",
	"invalid-member",
	"invalid-append",
	"invalid-read",
	"invalid-cursor",
	"cursor-filter-mismatch",
	"capacity-exceeded",
	"directory-capacity-exceeded",
	"lock-conflict",
	"read-failed",
	"write-failed",
	"quarantine-failed",
	"idempotency-conflict",
	"link-target-invalid",
	"board-failed",
]);
function boardErrorMessage(error: unknown, action: string): string {
	const rawCode = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : undefined;
	const code = rawCode && BOARD_COMMAND_CODES.has(rawCode) ? rawCode : "board-failed";
	return presentActionableError({
		code,
		operation: `/crew ${action}`,
		reason: "the Crew Board operation was rejected",
		recovery: ["verify project trust and crew membership, then retry."],
	}).message;
}

type AgreementActivationHandler = NonNullable<ControlCommandDeps["activateAgreementRevision"]>;

async function handleAgreementActivation(
	ctx: ExtensionContext,
	parsed: { readonly target?: string },
	activation: AgreementActivationHandler | undefined,
): Promise<void> {
	const target = parsed.target ?? "";
	if (!activation || !target.startsWith("activate ")) {
		notify(ctx, "Agreement activation is unavailable", "error");
		return;
	}
	const revisionId = target.slice("activate ".length);
	try {
		const result = await activation(revisionId, ctx);
		const failed = result.notices.filter((notice) => notice.status === "failed");
		const disposition = result.disposition === "unchanged" ? "already active" : "activated";
		const suffix =
			failed.length === 0 ? "" : `; notices failed for ${failed.map((notice) => notice.member).join(", ")}`;
		notify(
			ctx,
			`Agreement revision ${result.revisionId} ${disposition} (previous ${result.priorRevisionId})${suffix}`,
			failed.length === 0 ? "info" : "warning",
		);
	} catch (error) {
		notify(ctx, `Agreement activation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
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
	return formatCrewRoster(membership.manifestPath, rows, membership.manifest.name);
}

async function handleInboxAction(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	deps: ControlCommandDeps,
	target?: string,
): Promise<void> {
	const bridge = deps.inboxBridge;
	const sub = target ?? "";
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
}

async function handleBoardAction(
	action: "board" | "post",
	target: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	state: SocketState,
	deps: ControlCommandDeps,
	membership: MembershipRuntime | undefined,
): Promise<void> {
	const parsedBoard = parseCrewBoardCommand(action, target);
	if ("error" in parsedBoard) {
		notify(ctx, parsedBoard.error, "error");
		return;
	}
	const currentMembership = membership?.getMembership() ?? state.membershipRuntime?.getMembership() ?? null;
	if (!currentMembership) {
		notify(ctx, "Crew Board requires joined Membership", "error");
		return;
	}
	const board = boardDependencies(deps, state, membership);
	if (!board) {
		notify(ctx, "Crew Board is unavailable", "error");
		return;
	}
	try {
		if (parsedBoard.action === "post") {
			const now = deps.crewBoardNow?.() ?? Date.now();
			const operationId = deps.crewBoardOperationId?.(target) ?? `crew-post-${now}-${boardOperationSequence++}`;
			const result = await leaveCrewPost(
				{
					membership: currentMembership,
					operationId,
					kind: parsedBoard.kind,
					message: parsedBoard.message,
					references: parsedBoard.references,
					link:
						parsedBoard.relation && parsedBoard.postId
							? { relation: parsedBoard.relation, postId: parsedBoard.postId }
							: undefined,
					now,
				},
				board,
			);
			pi.appendEntry("crew-board", { content: renderCrewPostConfirmation(result) });
			return;
		}
		const result = await readCrewBoard(
			{
				membership: currentMembership,
				kinds: parsedBoard.kinds,
				after: parsedBoard.after,
				limit: parsedBoard.limit,
			},
			board,
		);
		pi.appendEntry("crew-board", { content: renderCrewBoard(result, parsedBoard.kinds) });
	} catch (error) {
		notify(ctx, boardErrorMessage(error, action), "error");
	}
}

export function registerSessionControlCommand(
	pi: ExtensionAPI,
	state: SocketState,
	deps: ControlCommandDeps,
	commandName = "crew",
): void {
	pi.registerCommand(commandName, {
		description:
			"Join and manage Crew; use /crew board to inspect shared Posts and /crew post to add one (pull-only).",

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

			if (parsed.action === "board" || parsed.action === "post") {
				await handleBoardAction(parsed.action, parsed.target, ctx, pi, state, deps, membership);
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
					const joinedOutput = `${joinedMessage}\nCrew Board: use /crew board to inspect shared Posts and /crew post to add one. Posts are pull-only and are not delivered automatically.`;
					deps.persistMembership?.(true, result.membership);
					deps.activateMembershipTool?.();
					deps.refreshStatus?.();
					await deps.refreshPresence?.();
					deps.announceMembership?.(joinedOutput);
					deps.inboxBridge?.establish(ownershipFromMembership(result.membership));
					void deps.inboxBridge?.attemptOffer();
					notify(ctx, joinedOutput);
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
							await deps.stopPresence?.();
							deps.announceMembership?.("Crew membership released");
							deps.inboxBridge?.invalidate();
						}
						notify(ctx, result.left ? "Crew membership released" : "Crew not joined");
					}
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
				case "inbox":
					await handleInboxAction(ctx, pi, deps, parsed.target);
					return;
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
				default:
					await handleAgreementActivation(ctx, parsed, deps.activateAgreementRevision);
					return;
			}
		},
	});
}
