import {
	isMessagePayload,
	renderFollowUpModelContent,
	SESSION_MESSAGE_TYPE,
	type RpcInboundCommand,
} from "../../domain/index.ts";
import type { CommandHandlerContext } from "./types.ts";
import { contextIsCompacting, notifyAcceptedMessage } from "./utils.ts";
export async function handleGuestJoin(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "guest_join" }>,
): Promise<void> {
	const { state, respond } = context;
	const membership = state.membershipRuntime?.getMembership();
	const admission = state.guestAdmissionRuntime;
	if (!membership || !admission) {
		respond(false, command.type, undefined, !membership ? "not-joined" : "guest-disabled");
		return;
	}
	if (state.context?.isProjectTrusted?.() !== true) {
		respond(false, command.type, undefined, "untrusted-project");
		return;
	}
	const result = admission.receive({
		requestId: `guest-${String(command.id)}`,
		crew: membership.manifest.crew
			? { id: membership.manifest.crew.id, displayName: membership.manifest.crew.displayName }
			: { id: "unknown", displayName: "unknown" },
		guestIdentity: command.guestIdentity,
		guestName: command.guestName,
		callbackEndpoint: command.callbackEndpoint,
		submittedByMember: membership.member.name,
	});
	if ("code" in result) {
		respond(false, command.type, undefined, result.code);
		return;
	}
	// The member-issued capability rides the approved join response exactly
	// once; the Guest runtime retains it and the registry holds only its digest.
	if (result.status === "approved") {
		const consumed = admission.consumeCapability(command.guestIdentity);
		respond(true, command.type, {
			status: result.status,
			requestId: result.requestId,
			crew: result.crew,
			...(consumed.ok ? { capability: consumed.capability } : {}),
		});
		return;
	}
	respond(true, command.type, { status: result.status, requestId: result.requestId, crew: result.crew });
}

export async function handleGuestSend(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "guest_send" }>,
): Promise<void> {
	const { state, respond, pi, ctx, id } = context;
	const membership = state.membershipRuntime?.getMembership();
	const admission = state.guestAdmissionRuntime;
	const guestRuntime = state.guestMembershipRuntime;
	if (!membership && !guestRuntime) {
		respond(false, command.type, undefined, "not-joined");
		return;
	}
	if (state.context?.isProjectTrusted?.() !== true) {
		respond(false, command.type, undefined, "untrusted-project");
		return;
	}
	// Authorization (fresh registry read) always precedes target resolution or
	// payload delivery. Member runtimes validate their admission registry;
	// Guest runtimes validate the sender against the same crew authority.
	if (membership && !admission) {
		respond(false, command.type, undefined, "guest-disabled");
		return;
	}
	const authorization = membership
		? admission!.authorizeSend({
				crewId: command.crewId,
				guestIdentity: command.guestIdentity,
				callbackEndpoint: command.callbackEndpoint,
				capability: command.capability,
			})
		: guestRuntime?.authorizeInbound?.({
				crewId: command.crewId,
				guestIdentity: command.guestIdentity,
				callbackEndpoint: command.callbackEndpoint,
				capability: command.capability,
			});
	if (!authorization?.ok) {
		respond(
			false,
			command.type,
			undefined,
			authorization && "code" in authorization ? authorization.code : "registry-unavailable",
		);
		return;
	}
	if (!membership && guestRuntime) {
		const recipient = guestRuntime.credentials(command.crewId);
		if (!recipient || recipient.guestName !== command.target) {
			respond(false, command.type, undefined, "crew-mismatch");
			return;
		}
	}
	const deliveredAt = state.now?.();
	const payload = {
		content: command.content,
		...(command.instructions === undefined ? {} : { instructions: [...command.instructions] }),
		origin: { kind: "guest" as const, identity: command.guestIdentity, name: authorization.guestName },
		kind: command.kind ?? ("follow-up" as const),
		...(deliveredAt === undefined ? {} : { sentAt: deliveredAt }),
	};
	if (!isMessagePayload(payload)) {
		respond(false, command.type, undefined, "invalid-payload");
		return;
	}
	const message = renderFollowUpModelContent(payload, deliveredAt);
	const customMessage = {
		customType: SESSION_MESSAGE_TYPE,
		content: message,
		details: { messagePayload: payload, ...(deliveredAt === undefined ? {} : { deliveredAt }) },
		display: true,
	};
	const isIdle = ctx.isIdle() && !contextIsCompacting(ctx);
	notifyAcceptedMessage(state, `delivery-${id}`);
	pi.sendMessage(customMessage, {
		triggerTurn: true,
		deliverAs: isIdle ? undefined : "followUp",
	});
	const disposition = isIdle ? "direct" : "queued";
	respond(true, "guest_send", {
		deliveryId: `delivery-${id}`,
		disposition,
		fromGuestName: authorization.guestName,
	});
}

export async function handleGuestLeave(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "guest_leave" }>,
): Promise<void> {
	const { state, respond } = context;
	const admission = state.guestAdmissionRuntime;
	if (!admission) {
		respond(false, command.type, undefined, "guest-disabled");
		return;
	}
	const result = admission.revoke(command.guestIdentity, command.crewId, command.callbackEndpoint);
	if ("code" in result) {
		respond(false, command.type, undefined, result.code);
		return;
	}
	respond(true, command.type, {});
}

export async function handlePresenceHint(
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: "presence_hint" }>,
): Promise<void> {
	const { ctx, state, socket, pi, respond, id } = context;
	const accepted =
		state.presenceObserver?.acceptHint({
			member: command.member,
			state: command.state,
			instanceId: command.instanceId,
		}) ?? false;
	respond(true, "presence_hint", { accepted });
	return;
}
