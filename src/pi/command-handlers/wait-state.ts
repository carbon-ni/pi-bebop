import type { RpcInboundCommand } from "../../domain/index.ts";
import { MAX_WAIT_STATE_SUBSCRIPTIONS, resolveWaitStateCaller } from "../../domain/index.ts";
import { writeWaitStateEvent } from "../../infra/rpc-server.ts";
import type { RpcCommandHandler } from "./types.ts";

/**
 * TASK-0117 `member.wait_state`: joined trusted peers atomically obtain the
 * bounded blocking-wait snapshot and arm exactly one transition notification.
 *
 * The snapshot carries only the observed member's configured identity, the
 * runtime-derived wait kind, and the observation time — never a wait target,
 * tool arguments, messages, session ids, or paths. The marker is never
 * author-supplied; callers can only observe. Subscriptions are one-shot,
 * capacity-bounded, and removed on socket disconnect.
 */
export const handleWaitState: RpcCommandHandler<Extract<RpcInboundCommand, { type: "wait_state" }>> = (
	command,
	context,
) => {
	const membership = context.state.membershipRuntime?.getMembership();
	if (!membership) {
		context.respond(false, "wait_state", undefined, "not-joined");
		return;
	}
	if (context.state.context?.isProjectTrusted?.() !== true) {
		context.respond(false, "wait_state", undefined, "untrusted");
		return;
	}
	const ownName = membership.member.name;
	const caller = resolveWaitStateCaller(membership.manifest.members, ownName, command.member);
	if (caller.ok === false) {
		context.respond(false, "wait_state", undefined, caller.code);
		return;
	}
	if (context.state.waitStateSubscriptions.length >= MAX_WAIT_STATE_SUBSCRIPTIONS) {
		context.respond(false, "wait_state", undefined, "capacity-exceeded");
		return;
	}

	const identity = { name: membership.member.name, role: membership.member.role };
	const subscriptionId = String(context.id);
	const { marker } = context.state.blockingWait.subscribeOnce((transition) => {
		removeSubscription(context.state.waitStateSubscriptions, subscriptionId);
		writeWaitStateEvent(context.socket, {
			subscriptionId,
			snapshot: { member: identity, wait: transition },
		});
	});
	context.state.waitStateSubscriptions.push({ socket: context.socket, subscriptionId });
	const cleanup = () => {
		removeSubscription(context.state.waitStateSubscriptions, subscriptionId);
	};
	context.socket.once("close", cleanup);
	context.socket.once("error", cleanup);
	context.respond(true, "wait_state", {
		subscriptionId,
		snapshot: { member: identity, wait: marker },
	});
};

function removeSubscription(
	subscriptions: Array<{ socket: unknown; subscriptionId: string }>,
	subscriptionId: string,
): void {
	const index = subscriptions.findIndex((subscription) => subscription.subscriptionId === subscriptionId);
	if (index !== -1) subscriptions.splice(index, 1);
}
