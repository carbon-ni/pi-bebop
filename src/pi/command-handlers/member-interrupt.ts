import { resolveInterruptTarget, type MemberInterruptRequest, type RpcInboundCommand } from "../../domain/index.ts";
import type { RpcCommandHandler, RpcHandlerContext } from "./types.ts";
import { deliverMemberInterrupt } from "./member-interrupt-delivery.ts";

type MemberInterruptCommand = Extract<RpcInboundCommand, { type: "member_interrupt" }>;

export const handleMemberInterrupt: RpcCommandHandler<MemberInterruptCommand> = async (command, context) => {
	const membership = context.state.membershipRuntime?.getMembership() ?? null;
	if (!membership) {
		context.respond(false, command.type, undefined, "not-joined");
		return;
	}
	if (context.state.context?.isProjectTrusted?.() !== true) {
		context.respond(false, command.type, undefined, "untrusted");
		return;
	}
	const resolution = resolveInterruptTarget(membership.manifest, membership.member.name, command.target);
	if (resolution.ok === false) {
		context.respond(false, command.type, undefined, resolution.code);
		return;
	}
	const request: MemberInterruptRequest = {
		senderName: membership.member.name,
		targetName: resolution.target.name,
		message: command.message,
		instructions: command.instructions,
		requestedAt: Date.now(),
	};
	await deliverMemberInterrupt(command, context, request, resolution.target);
};
