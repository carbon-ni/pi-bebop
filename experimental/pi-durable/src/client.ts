import { createConnection } from "node:net";
import { durableSocketPath } from "./member.ts";
import type { MemberServerRequest } from "./server.ts";

const MAX_RESPONSE_BYTES = 1_100_000;
const CONTROL_TIMEOUT_MS = 1_000;
const ADMISSION_TIMEOUT_MS = 5_000;
const SUBMISSION_TIMEOUT_MS = 120_000;

function requestTimeout(request: MemberServerRequest): number {
	if (request.type === "submit" || request.type === "awaitSubmission") return SUBMISSION_TIMEOUT_MS;
	if (request.type === "admit" || request.type === "admitInbox" || request.type === "drainInbox") return ADMISSION_TIMEOUT_MS;
	return CONTROL_TIMEOUT_MS;
}

export async function requestMember(storagePath: string, request: MemberServerRequest): Promise<Record<string, unknown>> {
	const socketPath = await durableSocketPath(storagePath);
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.setTimeout(requestTimeout(request), () => fail(new Error(`member host ${request.type} request timed out`)));
		let buffer = "";
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(error);
		};
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
				fail(new Error("member response exceeded the 1 MiB limit"));
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const result = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
				settled = true;
				socket.end();
				if (result.ok !== true) reject(new Error(String(result.error ?? "member request failed")));
				else resolve(result);
			} catch (error) {
				fail(error instanceof Error ? error : new Error("invalid member response"));
			}
		});
		socket.once("error", (error) => fail(new Error(`member host is not available: ${error.message}`)));
		socket.once("close", () => {
			if (!settled) fail(new Error("member host closed before responding"));
		});
	});
}
