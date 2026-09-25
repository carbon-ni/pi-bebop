import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderMemberRequestModelContent, SESSION_MESSAGE_TYPE, type RpcInboundCommand } from "../../domain/index.ts";
import type { GuestAdmissionRuntime } from "../../infra/guest-admission-runtime.ts";
import type { GuestMembershipRuntime } from "../../infra/guest-membership-runtime.ts";
import type { Membership } from "../../infra/membership-runtime.ts";
import { writeMemberUpdateEvent, type RpcSocket } from "../../infra/rpc-server.ts";
import type { MemberRequestFlow } from "../../application/member-request-flow.ts";
import type { CommandHandlerContext } from "./types.ts";
import { notifyAcceptedMessage } from "./utils.ts";

export type MemberRequestFlowCapability = Pick<
	MemberRequestFlow,
	| "sendMemberRequest"
	| "sendGuestMemberRequest"
	| "failBeforeAcceptance"
	| "listRequestSummaries"
	| "waitForRequestOutcomeById"
	| "registerInboundRequest"
	| "acceptInboundRequest"
	| "removeInboundRequest"
	| "respondToMemberRequest"
>;
export type GuestMembershipRequestCapability = Pick<GuestMembershipRuntime, "credentials" | "getMemberSocket">;
export type GuestAdmissionRequestCapability = Pick<GuestAdmissionRuntime, "authorizeSend">;

export interface MemberRequestHandlerContext {
	readonly pi: Pick<ExtensionAPI, "sendMessage">;
	readonly socket: RpcSocket;
	readonly respond: CommandHandlerContext["respond"];
	readonly getMembership: () => Membership | null;
	readonly getMemberRequestFlow: () => MemberRequestFlowCapability | undefined;
	readonly isProjectTrusted: () => boolean;
	readonly getGuestMembershipRuntime: () => GuestMembershipRequestCapability | undefined;
	readonly getGuestAdmissionRuntime: () => GuestAdmissionRequestCapability | undefined;
	readonly notifyAcceptedMessage: (deliveryId: string) => void;
	readonly now?: () => number;
}

export function createMemberRequestHandlerContext(context: CommandHandlerContext): MemberRequestHandlerContext {
	const { state } = context;
	return {
		pi: context.pi,
		socket: context.socket,
		respond: context.respond,
		getMembership: () => state.membershipRuntime?.getMembership() ?? null,
		getMemberRequestFlow: () => state.memberRequestFlow,
		isProjectTrusted: () => state.context?.isProjectTrusted?.() === true,
		getGuestMembershipRuntime: () => state.guestMembershipRuntime,
		getGuestAdmissionRuntime: () => state.guestAdmissionRuntime,
		notifyAcceptedMessage: (deliveryId) => notifyAcceptedMessage(state, deliveryId),
		now: state.now,
	};
}
export async function handleMemberRequest(
	context: MemberRequestHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_request" }>,
): Promise<void> {
	const { socket, pi, respond } = context;
	const membership = context.getMembership();
	const flow = context.getMemberRequestFlow();
	const origin = command.payload.origin;
	if (!flow || (!membership && !command.guestAuth)) {
		respond(false, command.type, undefined, !membership ? "not-joined" : "coordination-unavailable");
		return;
	}
	if (!context.isProjectTrusted()) {
		respond(false, command.type, undefined, "untrusted");
		return;
	}
	if (!origin || (origin.kind !== "crew" && origin.kind !== "guest")) {
		respond(false, command.type, undefined, "invalid-payload");
		return;
	}
	if (origin.kind === "guest") {
		const auth = command.guestAuth;
		const admission = context.getGuestAdmissionRuntime();
		if (!membership || !auth || !admission) {
			respond(false, command.type, undefined, "invalid-origin");
			return;
		}
		const authorized = admission.authorizeSend(auth);
		if (!authorized.ok || authorized.guestName !== origin.name || auth.guestIdentity !== origin.identity) {
			respond(false, command.type, undefined, "invalid-origin");
			return;
		}
	} else {
		const configuredOrigin = membership?.manifest.members.find(
			(member) => member.name === origin.name && member.role === origin.role,
		);
		if (!configuredOrigin || configuredOrigin.name === membership?.member.name) {
			respond(false, command.type, undefined, "invalid-origin");
			return;
		}
	}
	try {
		flow.registerInboundRequest({
			requestId: command.requestId,
			requester: { name: origin.name, role: origin.kind === "guest" ? "guest" : origin.role },
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
		const deliveredAt = context.now?.();
		const message = renderMemberRequestModelContent(command.payload, command.requestId, deliveredAt);
		context.notifyAcceptedMessage(command.requestId);
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
		flow.failBeforeAcceptance(command.requestId);
		respond(false, command.type, undefined, error instanceof Error ? error.message : "delivery-failed");
	}
	return;
}

export async function handleMemberRequestStart(
	context: MemberRequestHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_request_start" }>,
): Promise<void> {
	const { respond } = context;
	const membership = context.getMembership();
	const flow = context.getMemberRequestFlow();
	const guestRuntime = context.getGuestMembershipRuntime();
	if (!flow || (!membership && (!guestRuntime || !command.crew))) {
		respond(false, command.type, undefined, !membership ? "not-joined" : "coordination-unavailable");
		return;
	}
	if (!context.isProjectTrusted()) {
		respond(false, command.type, undefined, "untrusted");
		return;
	}
	try {
		let accepted: Awaited<ReturnType<MemberRequestFlowCapability["sendMemberRequest"]>>;
		if (membership) {
			accepted = await flow.sendMemberRequest({
				membership,
				member: command.target,
				message: command.message,
				instructions: command.instructions,
				timeoutSeconds: command.timeoutSeconds,
				maxWaitSeconds: command.maxWaitSeconds,
			});
		} else {
			if (!guestRuntime || !command.crew) throw new Error("not-approved");
			const credentials = guestRuntime.credentials(command.crew);
			const memberSocket = guestRuntime.getMemberSocket(command.crew);
			if (!credentials || !memberSocket) throw new Error("not-approved");
			accepted = await flow.sendGuestMemberRequest({
				crewId: command.crew,
				memberSocket,
				target: { name: command.target },
				guestIdentity: credentials.guestIdentity,
				guestName: credentials.guestName,
				callbackEndpoint: credentials.callbackEndpoint,
				capability: credentials.capability,
				message: command.message,
				instructions: command.instructions,
				timeoutSeconds: command.timeoutSeconds,
				maxWaitSeconds: command.maxWaitSeconds,
			});
		}
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
	context: MemberRequestHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_request_list" }>,
): Promise<void> {
	const membership = context.getMembership();
	const flow = context.getMemberRequestFlow();
	if (!membership || !flow) {
		context.respond(false, command.type, undefined, !membership ? "not-joined" : "coordination-unavailable");
		return;
	}
	const direction = command.direction ?? "all";
	context.respond(true, command.type, { requests: flow.listRequestSummaries(direction), omitted: 0 });
}

export async function handleMemberRequestWait(
	context: MemberRequestHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_request_wait" }>,
): Promise<void> {
	const membership = context.getMembership();
	const flow = context.getMemberRequestFlow();
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
	context: MemberRequestHandlerContext,
	command: Extract<RpcInboundCommand, { type: "member_response" }>,
): Promise<void> {
	const { respond } = context;
	const membership = context.getMembership();
	const flow = context.getMemberRequestFlow();
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
