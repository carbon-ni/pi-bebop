import { EventEmitter } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSocketState } from "../control-runtime.ts";
import type { RpcSocket } from "../../infra/rpc-server.ts";
import type { RpcHandlerContext } from "./types.ts";

export function handlerContext(
	overrides: Partial<RpcHandlerContext> = {},
): RpcHandlerContext & { responses: unknown[] } {
	const responses: unknown[] = [];
	const state = createSocketState();
	state.context = {
		isIdle: () => true,
		isCompacting: () => false,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => "root" },
	} as never;
	return {
		pi: { sendMessage: () => undefined, appendEntry: () => undefined } as never,
		state,
		ctx: state.context as ExtensionContext,
		socket: new EventEmitter() as never as RpcSocket,
		id: "test-id",
		respond: (_success, _command, data, error) => responses.push({ data, error }),
		contextIsCompacting: () => false,
		notifyAcceptedMessage: () => undefined,
		deriveIntrayStatus: (server, joined) => (server ? (joined ? "joined" : "online") : "stopped"),
		responses,
		...overrides,
	};
}
