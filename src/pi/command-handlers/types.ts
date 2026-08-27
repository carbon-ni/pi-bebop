import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpcInboundCommand, RpcId } from "../../domain/index.ts";
import type { RpcSocket } from "../../infra/rpc-server.ts";
import type { SocketState } from "../control-runtime.ts";

export interface RpcHandlerContext {
	pi: ExtensionAPI;
	state: SocketState;
	ctx: ExtensionContext;
	socket: RpcSocket;
	id: RpcId;
	respond: (success: boolean, commandName: string, data?: unknown, error?: string) => void;
	contextIsCompacting: () => boolean;
	notifyAcceptedMessage: (deliveryId: string) => void;
	deriveIntrayStatus: (serverPresent: boolean, membershipActive: boolean) => string;
}

export type RpcCommandHandler<C extends RpcInboundCommand = RpcInboundCommand> = (
	command: C,
	context: RpcHandlerContext,
) => void | Promise<void>;

export type AnyRpcCommandHandler = RpcCommandHandler<RpcInboundCommand>;
