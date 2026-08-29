import {
	createMemberMessageCoordinator,
	sendMemberMessage,
	MemberMessageError,
} from "../../application/member-message.ts";
import { sendRpcCommand } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import type { RpcInboundCommand } from "../../domain/index.ts";
import type { RpcHandlerContext } from "./types.ts";

type MemberMessageCommand = Extract<RpcInboundCommand, { type: "member_follow_up" | "member_redirect" }>;

function respondMemberMessageError(error: unknown, command: MemberMessageCommand, context: RpcHandlerContext): void {
	if (error instanceof MemberMessageError) {
		context.respond(false, command.type, undefined, error.code);
		return;
	}
	if (error instanceof Error && error.name === "AbortError") {
		context.respond(false, command.type, undefined, "aborted");
		return;
	}
	if (error instanceof Error && "code" in error && error.code === "outcome-unknown") {
		context.respond(false, command.type, undefined, "outcome-unknown");
		return;
	}
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "ENOENT" || systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") {
		context.respond(false, command.type, undefined, "offline");
		return;
	}
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) {
		context.respond(false, command.type, undefined, "timeout");
		return;
	}
	context.respond(false, command.type, undefined, "transport-error");
}

export async function deliverMemberMessage(command: MemberMessageCommand, context: RpcHandlerContext): Promise<void> {
	const membership = context.state.membershipRuntime?.getMembership();
	const dependencies = context.state.memberMessageDependencies ?? {
		transport: { send: sendRpcCommand },
		resolveEndpoint: resolveMemberEndpoint,
		coordinator: createMemberMessageCoordinator(),
	};
	const controller = new AbortController();
	const onDisconnect = () => controller.abort();
	context.socket.once("close", onDisconnect);
	context.socket.once("error", onDisconnect);
	try {
		const outcome = await sendMemberMessage(
			{
				membership: membership as never,
				member: command.target,
				message: command.message,
				instructions: command.instructions,
				intent: command.type === "member_redirect" ? "immediate" : "follow_up",
				signal: controller.signal,
			},
			dependencies,
		);
		context.respond(true, command.type, {
			member: { name: outcome.target.name, role: outcome.target.role },
			deliveryId: outcome.deliveryId,
			disposition: outcome.disposition,
			...(outcome.deferred === true ? { deferred: true } : {}),
		});
	} catch (error) {
		respondMemberMessageError(error, command, context);
	} finally {
		controller.abort();
	}
}
