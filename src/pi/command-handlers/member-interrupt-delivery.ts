import {
	isInterruptResult,
	createInterruptRecoveryPayload,
	type MemberInterruptRequest,
	type RpcInboundCommand,
} from "../../domain/index.ts";
import { sendRpcCommand } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import type { RpcSocket } from "../../infra/rpc-server.ts";
import type { RpcHandlerContext } from "./types.ts";

type MemberInterruptCommand = Extract<RpcInboundCommand, { type: "member_interrupt" }>;

function mapMemberInterruptError(error: unknown): string {
	const remoteCode = error instanceof Error ? /^remote-error:\s*(\S+)$/.exec(error.message)?.[1] : undefined;
	const targetCode = new Set([
		"invalid-payload",
		"already-pending",
		"abort-failed",
		"no-context",
		"handoff-failed",
		"aborted",
	]);
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	if (remoteCode !== undefined && targetCode.has(remoteCode)) return remoteCode;
	if (error instanceof Error && "code" in error && error.code === "outcome-unknown") return "outcome-unknown";
	if (systemCode === "ENOENT" || systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return "offline";
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return "timeout";
	return "transport-error";
}

export async function deliverMemberInterrupt(
	command: MemberInterruptCommand,
	context: RpcHandlerContext,
	request: MemberInterruptRequest,
	target: { name: string; role: string; socketPath: string },
): Promise<void> {
	try {
		const payload = createInterruptRecoveryPayload(
			context.state.membershipRuntime!.getMembership()!.member,
			request,
		);
		const endpoint = await (context.state.memberInterruptResolveEndpoint ?? resolveMemberEndpoint)(
			target.socketPath,
		);
		const controller = new AbortController();
		const onDisconnect = () => controller.abort();
		context.socket.once("close", onDisconnect);
		context.socket.once("error", onDisconnect);
		const removeDisconnectListeners = () => {
			const removable = context.socket as RpcSocket & {
				removeListener?: (event: "close" | "error", listener: () => void) => void;
			};
			removable.removeListener?.("close", onDisconnect);
			removable.removeListener?.("error", onDisconnect);
		};
		try {
			const { response } = await (context.state.memberInterruptSend ?? sendRpcCommand)(
				endpoint,
				{ type: "interrupt", payload },
				{ timeout: 5000, signal: controller.signal, classifyLostAck: true },
			);
			if (!response.success) {
				context.respond(false, command.type, undefined, response.error ?? "remote-rejected");
				return;
			}
			if (!isInterruptResult(response.data)) {
				context.respond(false, command.type, undefined, "invalid-ack");
				return;
			}
			context.respond(true, command.type, {
				member: { name: target.name, role: target.role },
				interruptId: response.data.interruptId,
				disposition: response.data.disposition,
			});
		} finally {
			controller.abort();
			removeDisconnectListeners();
		}
	} catch (error) {
		context.respond(false, command.type, undefined, mapMemberInterruptError(error));
	}
}
