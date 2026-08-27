import type { RpcInboundCommand } from "../../domain/index.ts";
import type { RpcHandlerContext, RpcCommandHandler } from "./types.ts";
import { deliverMemberMessage } from "./member-message-delivery.ts";

type MemberMessageCommand = Extract<RpcInboundCommand, { type: "member_follow_up" | "member_redirect" }>;

export const handleMemberMessage: RpcCommandHandler<MemberMessageCommand> = async (command, context) => {
	if (!context.state.membershipRuntime?.getMembership()) {
		context.respond(false, command.type, undefined, "not-joined");
		return;
	}
	if (context.state.context?.isProjectTrusted?.() !== true) {
		context.respond(false, command.type, undefined, "untrusted");
		return;
	}
	await deliverMemberMessage(command, context);
};
