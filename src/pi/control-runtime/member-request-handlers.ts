import { renderMemberRequestModelContent, SESSION_MESSAGE_TYPE, type RpcInboundCommand } from "../../domain/index.ts";
import { writeMemberUpdateEvent } from "../../infra/rpc-server.ts";
import type { CommandHandlerContext } from "./types.ts";
import { notifyAcceptedMessage } from "./utils.ts";
export async function handleMemberRequest(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_request" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const membership = state.membershipRuntime?.getMembership();
	const flow = state.memberRequestFlow;
	const origin = command.payload.origin;
	if (!membership || !flow) {
		respond(false, command.type, undefined, !membership ? "not-joined" : "coordination-unavailable");
		return;
	}
	if (state.context?.isProjectTrusted?.() !== true) {
		respond(false, command.type, undefined, "untrusted");
		return;
	}
	if (!origin || origin.kind !== "crew") {
		respond(false, command.type, undefined, "invalid-payload");
		return;
	}
	const configuredOrigin = membership.manifest.members.find(
		(member) => member.name === origin.name && member.role === origin.role,
	);
	if (!configuredOrigin || configuredOrigin.name === membership.member.name) {
		respond(false, command.type, undefined, "invalid-origin");
		return;
	}
	try {
		flow.registerInboundRequest({
			requestId: command.requestId,
			requester: { name: origin.name, role: origin.role },
			message: command.payload.content,
			instructions: command.payload.instructions ?? [],
			channel: {
				send: async (update) => writeMemberUpdateEvent(socket, update),
				close: () => undefined,
			},
		});
		const cleanupInbound = () => {
			flow.removeInboundRequest(command.requestId);
		};
		socket.once("close", cleanupInbound);
		socket.once("error", cleanupInbound);
		// Registration precedes Pi visibility. Once sendMessage accepts the
		// request into context, arm idle handling and acknowledge delivery.
		// TASK-0081: accepted Bebop model delivery wakes a local blocking idle wait.
		const deliveredAt = state.now?.();
		const message = renderMemberRequestModelContent(command.payload, command.requestId, deliveredAt);
		notifyAcceptedMessage(state, command.requestId);
		pi.sendMessage(
			{
				customType: SESSION_MESSAGE_TYPE,
				content: message,
				details: {
					messagePayload: command.payload,
					crewRequestId: command.requestId,
					...(deliveredAt === undefined ? {} : { deliveredAt }),
				},
				display: true,
			},
			{ triggerTurn: true },
		);
		flow.acceptInboundRequest(command.requestId);
		respond(true, command.type, {
			accepted: true,
			requestId: command.requestId,
			member: { name: membership.member.name, role: membership.member.role },
		});
	} catch (error) {
		flow.registry.failBeforeAcceptance(command.requestId);
		respond(false, command.type, undefined, error instanceof Error ? error.message : "delivery-failed");
	}
	return;
}

export async function handleMemberRequestStart(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_request_start" }>,
): Promise<void> {
	const { state, respond } = context;
	const membership = state.membershipRuntime?.getMembership();
	const flow = state.memberRequestFlow;
	if (!membership || !flow) {
		respond(false, command.type, undefined, !membership ? "not-joined" : "coordination-unavailable");
		return;
	}
	try {
		const accepted = await flow.sendMemberRequest({
			membership,
			member: command.target,
			message: command.message,
			instructions: command.instructions,
			timeoutSeconds: command.timeoutSeconds,
			maxWaitSeconds: command.maxWaitSeconds,
		});
		const member =
			accepted.member.kind === "member"
				? { name: accepted.member.name, role: accepted.member.role }
				: { name: accepted.member.guestName, role: "guest" };
		respond(true, command.type, { accepted: true, requestId: accepted.requestId, member });
	} catch (error) {
		respond(false, command.type, undefined, error instanceof Error ? error.message : "request-failed");
	}
}

export async function handleMemberRequestList(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_request_list" }>,
): Promise<void> {
	const membership = context.state.membershipRuntime?.getMembership();
	const flow = context.state.memberRequestFlow;
	if (!membership || !flow) {
		context.respond(false, command.type, undefined, !membership ? "not-joined" : "coordination-unavailable");
		return;
	}
	const direction = command.direction ?? "all";
	const outbound =
		direction === "inbound"
			? []
			: flow.registry.outboundSummaries().map((item) => ({
					direction: "outbound" as const,
					requestId: item.requestId,
					member: item.member,
					state: item.state,
					deadlineAt: item.deadlineAt,
				}));
	const inbound =
		direction === "outbound"
			? []
			: flow.registry.inboundSummaries().map((item) => ({
					direction: "inbound" as const,
					requestId: item.requestId,
					member: item.requester,
					state: item.state,
				}));
	const orderByRequestId = new Map(
		[...flow.registry.outboundSummaries(), ...flow.registry.inboundSummaries()].map((item) => [
			item.requestId,
			item.order,
		]),
	);
	const ordered = [...outbound, ...inbound].sort(
		(left, right) =>
			(orderByRequestId.get(left.requestId) ?? Number.MAX_SAFE_INTEGER) -
				(orderByRequestId.get(right.requestId) ?? Number.MAX_SAFE_INTEGER) ||
			left.requestId.localeCompare(right.requestId),
	);
	context.respond(true, command.type, { requests: ordered, omitted: 0 });
}

export async function handleMemberRequestWait(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_request_wait" }>,
): Promise<void> {
	const membership = context.state.membershipRuntime?.getMembership();
	const flow = context.state.memberRequestFlow;
	if (!membership || !flow) {
		context.respond(false, command.type, undefined, !membership ? "not-joined" : "coordination-unavailable");
		return;
	}
	let closed = false;
	const waiting = flow.waitForRequestOutcomeById(command.requestId, (outcome) => {
		if (closed) return;
		context.respond(true, command.type, outcome);
	});
	if (waiting.ok === false) {
		context.respond(false, command.type, undefined, waiting.code);
		return;
	}
	if (waiting.kind === "update") {
		context.respond(true, command.type, waiting.update);
		return;
	}
	const cancel = () => {
		closed = true;
		waiting.cancel();
	};
	context.socket.once("close", cancel);
	context.socket.once("error", cancel);
}

export async function handleMemberResponse(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_response" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const membership = state.membershipRuntime?.getMembership();
	const flow = state.memberRequestFlow;
	if (!membership || !flow) {
		respond(false, command.type, undefined, !membership ? "not-joined" : "no-pending-request");
		return;
	}
	try {
		await flow.respondToMemberRequest({
			message: command.message,
			instructions: command.instructions,
			requestId: command.requestId,
			member: { name: membership.member.name, role: membership.member.role },
		});
		respond(true, command.type, {});
	} catch (error) {
		respond(false, command.type, undefined, error instanceof Error ? error.message : "response-failed");
	}
	return;
}
