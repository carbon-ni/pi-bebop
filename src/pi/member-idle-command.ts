import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseCrewIdleMemberArgument, type CrewIdleWaitResult } from "../domain/index.ts";
import type { CrewIdleWaitInputWithCaller } from "../application/crew-idle-wait-flow.ts";
import { contextIsCompacting, type SocketState } from "./control-runtime.ts";

export type CrewIdleWaitOperation = {
	readonly wait: (input: CrewIdleWaitInputWithCaller) => Promise<CrewIdleWaitResult>;
};

const MEMBER_IDLE_STATUS_KEY = "pi-bebop-member-idle";

function renderResult(result: CrewIdleWaitResult): string {
	const targets = result.members.map((member) => `${member.name} (${member.role})`).join(", ") || "none";
	const blockers = result.blockers
		?.map((item) => `${item.member.name} (${item.member.role}): ${item.status}`)
		.join(", ");
	return `Crew member-idle: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}; targets=${targets}; coversAllOtherMembers=${result.coversAllOtherMembers}; observedAt=${result.observedAt}; caveat=momentary distributed observation, not a whole-Crew atomic state${blockers ? `; blockers=${blockers}` : ""}`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	} catch {
		// Notification failure must not strand an active observation.
	}
}

function parseSelection(target: string | undefined, ctx: ExtensionContext): readonly string[] | undefined | null {
	try {
		return parseCrewIdleMemberArgument(target);
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : "Invalid member-idle selection", "error");
		return null;
	}
}

function validateLocalState(ctx: ExtensionContext): boolean {
	if (ctx.isIdle() && !contextIsCompacting(ctx) && !ctx.hasPendingMessages()) return true;
	notify(ctx, "Crew member-idle requires a locally idle, non-compacting session with no pending messages", "warning");
	return false;
}

async function runObservation(
	state: SocketState,
	operation: CrewIdleWaitOperation,
	members: readonly string[] | undefined,
	ctx: ExtensionContext,
): Promise<void> {
	const lease = state.crewIdleCapacity.acquire("crew-member-idle-command");
	if (!lease) {
		notify(ctx, "Another blocking idle wait is already active", "warning");
		return;
	}
	const controller = new AbortController();
	let cancelReason: string | undefined;
	const owner = {
		cancel: (reason: string) => {
			if (controller.signal.aborted) return;
			cancelReason = reason;
			controller.abort();
		},
	};
	state.crewMemberIdleCommand = owner;
	try {
		if (ctx.hasUI) ctx.ui.setStatus(MEMBER_IDLE_STATUS_KEY, "Crew member-idle: observing configured Members…");
		const result = await operation.wait({ members: members ? [...members] : undefined, signal: controller.signal });
		notify(ctx, renderResult(result), "info");
	} catch (error) {
		const reason = cancelReason ?? (error instanceof Error ? error.message : "observation failed");
		notify(ctx, `Crew member-idle ended: ${reason}`, cancelReason ? "warning" : "error");
	} finally {
		try {
			if (ctx.hasUI) ctx.ui.setStatus(MEMBER_IDLE_STATUS_KEY, undefined);
		} catch {
			// Rendering cleanup must not prevent cancellation and slot release.
		}
		if (state.crewMemberIdleCommand === owner) state.crewMemberIdleCommand = undefined;
		controller.abort();
		lease.release();
	}
}

export function createMemberIdleCommandHandler(
	state: SocketState,
	operation: CrewIdleWaitOperation | undefined,
): (target: string | undefined, ctx: ExtensionContext) => Promise<void> {
	return async (target, ctx) => {
		const members = parseSelection(target, ctx);
		if (members === null) return;
		if (!state.membershipRuntime?.getMembership() || ctx.isProjectTrusted?.() !== true) {
			notify(ctx, "Crew member-idle is unavailable: join a trusted Crew first", "error");
			return;
		}
		if (!validateLocalState(ctx)) return;
		if (!operation) {
			notify(ctx, "Crew member-idle is unavailable", "error");
			return;
		}
		if (state.crewMemberIdleCommand || state.blockingWait.activeMarker()) {
			notify(ctx, "Another blocking idle wait is already active", "warning");
			return;
		}
		await runObservation(state, operation, members, ctx);
	};
}
