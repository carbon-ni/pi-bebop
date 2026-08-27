import type { RpcInboundCommand } from "../../domain/index.ts";
import type { RpcCommandHandler } from "./types.ts";
import { handleMemberMessage } from "./member-message.ts";

export const handleMemberRedirect: RpcCommandHandler<Extract<RpcInboundCommand, { type: "member_redirect" }>> = (
	command,
	context,
) => handleMemberMessage(command, context);
