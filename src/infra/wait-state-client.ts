import * as net from "node:net";
import { randomUUID } from "node:crypto";
import {
	commandToRequest,
	isMethodResult,
	isRpcResponse,
	isWaitStateNotification,
	isWaitStateSnapshot,
	serializeRequest,
	type RpcCommand,
	type WaitStateSnapshot,
} from "../domain/index.ts";

export interface MemberWaitStateClientOptions {
	signal?: AbortSignal;
	onTransition: (snapshot: WaitStateSnapshot) => void;
}
export type MemberWaitStateClientOutcome =
	| { readonly ok: true; readonly snapshot: WaitStateSnapshot }
	| { readonly ok: false; readonly code: "malformed-response" | "remote-rejected" | "transport-error" | "aborted" };
const nextId = () => `rpc_${randomUUID()}`;

/** Open a wait-state snapshot channel. The promise resolves at the initial
 * snapshot; the socket stays open until cancellation and forwards one-shot
 * transition notifications to the caller. */
export async function sendMemberWaitState(
	socketPath: string,
	command: Extract<RpcCommand, { type: "wait_state" }>,
	options: MemberWaitStateClientOptions,
): Promise<MemberWaitStateClientOutcome> {
	const requestId = command.id ?? nextId();
	const request = commandToRequest(command, requestId);
	return new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve({ ok: false, code: "aborted" });
			return;
		}
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		let settled = false;
		let closed = false;
		let timeoutHandle: NodeJS.Timeout;
		const cleanup = () => {
			if (closed) return;
			closed = true;
			clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
			socket.destroy();
		};
		const finish = (outcome: MemberWaitStateClientOutcome) => {
			if (settled) {
				cleanup();
				return;
			}
			settled = true;
			cleanup();
			resolve(outcome);
		};
		const onAbort = () => finish({ ok: false, code: "aborted" });
		options.signal?.addEventListener("abort", onAbort, { once: true });
		timeoutHandle = setTimeout(() => finish({ ok: false, code: "transport-error" }), 5000);
		socket.on("connect", () => {
			try {
				socket.write(serializeRequest(request));
			} catch {
				finish({ ok: false, code: "transport-error" });
			}
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					finish({ ok: false, code: "malformed-response" });
					return;
				}
				if (isWaitStateNotification(value)) {
					if (!isWaitStateSnapshot(value.params.snapshot)) {
						finish({ ok: false, code: "malformed-response" });
						return;
					}
					options.onTransition(value.params.snapshot);
					continue;
				}
				if (!isRpcResponse(value) || value.id !== requestId || settled) {
					finish({ ok: false, code: "malformed-response" });
					return;
				}
				if ("error" in value) {
					finish({ ok: false, code: "remote-rejected" });
					return;
				}
				if (
					!isMethodResult(request.method, value.result) ||
					!value.result ||
					typeof value.result !== "object"
				) {
					finish({ ok: false, code: "malformed-response" });
					return;
				}
				const result = value.result as { snapshot?: unknown };
				if (!isWaitStateSnapshot(result.snapshot)) {
					finish({ ok: false, code: "malformed-response" });
					return;
				}
				settled = true;
				clearTimeout(timeoutHandle);
				resolve({ ok: true, snapshot: result.snapshot });
			}
		});
		socket.on("error", () => finish({ ok: false, code: "transport-error" }));
		socket.on("end", () => {
			if (!settled) finish({ ok: false, code: "transport-error" });
		});
		socket.on("close", () => {
			if (!settled) finish({ ok: false, code: "transport-error" });
		});
	});
}
