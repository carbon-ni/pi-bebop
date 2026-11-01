import { createServer, type Socket } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import type { DurableMember } from "./member.ts";

const MAX_FRAME_BYTES = 16 * 1024;

export type MemberServerRequest =
	| { readonly type: "status" }
	| { readonly type: "submit"; readonly memberId: string; readonly message: string; readonly requestId: string }
	| { readonly type: "admit"; readonly memberId: string; readonly message: string; readonly requestId: string }
	| { readonly type: "admitInbox"; readonly memberId: string; readonly itemId: string; readonly message: string; readonly payloadHash: string }
	| { readonly type: "awaitSubmission"; readonly memberId: string; readonly submissionId: string }
	| { readonly type: "drainInbox" }
	| { readonly type: "stop" };

export interface MemberServerOptions {
	readonly socketPath: string;
	readonly memberId: string;
	readonly role?: string;
	readonly modelId?: string;
	readonly workspacePath?: string;
	readonly instructionsHash?: string;
	readonly inboxManifestPath?: string | null;
	readonly trustedProjectRoot?: string | null;
	readonly conversationId: number;
	readonly member: DurableMember;
	readonly shutdownGraceMs?: number;
	readonly onShutdownTimeout?: () => void | Promise<void>;
	readonly onRequestSettled?: () => void | Promise<void>;
	readonly onListening?: () => void | Promise<void>;
	readonly drainInbox?: () => Promise<number>;
}

function send(socket: Socket, value: unknown): void {
	if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`);
}

export async function runMemberServer(options: MemberServerOptions): Promise<void> {
	try {
		const existing = await lstat(options.socketPath);
		if (!existing.isSocket() || existing.uid !== process.getuid?.())
			throw new Error("refusing to replace an unsafe member endpoint");
		await unlink(options.socketPath);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
	}

	let closing = false;
	let ready = false;
	let closeResolve!: () => void;
	let stopOperation: Promise<void> | undefined;
	const connections = new Set<Socket>();
	const closed = new Promise<void>((resolve) => (closeResolve = resolve));
	const server = createServer((socket) => {
		if (closing) {
			socket.destroy();
			return;
		}
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
		socket.on("error", () => undefined);
		socket.setEncoding("utf8");
		let buffer = "";
		let handled = false;
		const reject = (message: string) => {
			if (handled) return;
			handled = true;
			send(socket, { ok: false, error: message });
		};
		socket.on("data", (chunk: string) => {
			if (handled) return;
			buffer += chunk;
			if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
				reject("request exceeds the 16 KiB limit");
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			handled = true;
			let request: MemberServerRequest;
			try {
				request = JSON.parse(buffer.slice(0, newline)) as MemberServerRequest;
			} catch {
				send(socket, { ok: false, error: "invalid JSON request" });
				return;
			}
			void handleRequest(request, socket);
		});
		socket.on("end", () => {
			if (!handled && buffer.length > 0) reject("request must end with a newline");
		});
	});

	const stop = (stopSocket: Socket): Promise<void> => {
		if (stopOperation) return stopOperation;
		closing = true;
		stopOperation = (async () => {
			const serverClosed = new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
			for (const connection of connections) {
				if (connection !== stopSocket) connection.destroy();
			}
			try {
				await serverClosed;
				let timeout: NodeJS.Timeout | undefined;
				const memberClosed = await Promise.race([
					options.member.close().then(() => true),
					new Promise<boolean>((resolve) => {
						timeout = setTimeout(() => resolve(false), options.shutdownGraceMs ?? 5_000);
					}),
				]).finally(() => {
					if (timeout) clearTimeout(timeout);
				});
				if (!memberClosed) {
					await options.onShutdownTimeout?.();
					return;
				}
				await unlink(options.socketPath);
			} catch {
				// Shutdown must still release the host process if cleanup fails.
			} finally {
				closeResolve();
			}
		})();
		return stopOperation;
	};

	const handleRequest = async (request: MemberServerRequest, socket: Socket): Promise<void> => {
		try {
			if (!ready && request.type !== "status" && request.type !== "stop")
				throw new Error("member host is still initializing its trusted startup hook");
			if (request.type === "status") {
				send(socket, {
					ok: true,
					pid: process.pid,
					memberId: options.memberId,
					role: options.role,
					modelId: options.modelId,
					workspacePath: options.workspacePath,
					instructionsHash: options.instructionsHash,
					inboxManifestPath: options.inboxManifestPath,
					trustedProjectRoot: options.trustedProjectRoot,
					conversationId: options.conversationId,
					status: ready ? "running" : "initializing",
				});
				return;
			}
			if (request.type === "submit") {
				if (request.memberId !== options.memberId) throw new Error("request member identity does not match this host");
				if (typeof request.message !== "string" || request.message.length === 0 || request.message.length > 8_000)
					throw new Error("message must contain 1 to 8000 characters");
				if (typeof request.requestId !== "string" || request.requestId.length === 0 || request.requestId.length > 256)
					throw new Error("requestId must contain 1 to 256 characters");
				// The member owns this promise. Closing the client socket never aborts accepted work.
				const result = await options.member.submit(request.message, request.requestId);
				await options.onRequestSettled?.();
				send(socket, { ok: true, result });
				return;
			}
			if (request.type === "admit") {
				if (request.memberId !== options.memberId) throw new Error("request member identity does not match this host");
				if (typeof request.message !== "string" || request.message.length === 0 || request.message.length > 8_000)
					throw new Error("message must contain 1 to 8000 characters");
				if (typeof request.requestId !== "string" || request.requestId.length === 0 || request.requestId.length > 256)
					throw new Error("requestId must contain 1 to 256 characters");
				const admission = await options.member.admit(request.message, request.requestId);
				send(socket, { ok: true, ...admission });
				return;
			}
			if (request.type === "admitInbox") {
				if (request.memberId !== options.memberId) throw new Error("request member identity does not match this host");
				const admission = await options.member.admitInbox(request.itemId, request.message, request.payloadHash);
				send(socket, { ok: true, ...admission });
				return;
			}
			if (request.type === "awaitSubmission") {
				if (request.memberId !== options.memberId) throw new Error("request member identity does not match this host");
				const result = await options.member.awaitSubmission(request.submissionId);
				await options.onRequestSettled?.();
				send(socket, { ok: true, result });
				return;
			}
			if (request.type === "drainInbox") {
				const admitted = await options.drainInbox?.();
				send(socket, { ok: true, admitted: admitted ?? 0 });
				return;
			}
			if (request.type === "stop") {
				send(socket, { ok: true, status: "stopping" });
				setImmediate(() => void stop(socket));
				return;
			}
			throw new Error("unknown request type");
		} catch (error) {
			send(socket, { ok: false, error: error instanceof Error ? error.message : "member request failed" });
		}
	};

	let startupError: unknown;
	server.listen(options.socketPath, async () => {
		try {
			await chmod(options.socketPath, 0o600);
			await options.onListening?.();
			ready = true;
		} catch (error) {
			startupError = error;
			server.close();
			closeResolve();
		}
	});
	server.on("error", (error) => {
		startupError = error;
		closeResolve();
	});
	await closed;
	if (startupError !== undefined) throw startupError;
}
