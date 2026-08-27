import type { RpcInboundCommand } from "../../domain/index.ts";
import type { RpcCommandHandler } from "./types.ts";
import { handleMemberMessage } from "./member-message.ts";

export const handleMemberFollowUp: RpcCommandHandler<Extract<RpcInboundCommand, { type: "member_follow_up" }>> = (
	command,
	context,
) => handleMemberMessage(command, context);
