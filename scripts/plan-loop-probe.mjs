import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * Runs the public member-status CLI and reduces its closed JSON envelope to the
 * plan loop's conservative worker state. No socket or crew manifest access.
 */
export async function probeMemberStatus(worker, options = {}) {
	const command = options.command ?? process.env.PI_BEBOP_COMMAND ?? "pi-bebop";
	const args = ["member", "status", worker.name, "--format", "json"];
	const session = options.session ?? process.env.PI_SESSION_ID;
	if (session) args.push("--session", session);
	try {
		const result = await (options.run ?? execFile)(command, args, {
			cwd: options.cwd,
			timeout: options.timeoutMs ?? 3000,
			maxBuffer: 256 * 1024,
			windowsHide: true,
		});
		return parseMemberStatusEnvelope(result.stdout, worker);
	} catch (error) {
		const stdout = error?.stdout;
		if (typeof stdout === "string") return parseMemberStatusEnvelope(stdout, worker);
		return { kind: "offline", detail: error?.code ?? "probe-failed" };
	}
}

export function parseMemberStatusEnvelope(stdout, worker) {
	let envelope;
	try {
		envelope = JSON.parse(stdout.trim());
	} catch {
		return { kind: "error", detail: "malformed-response" };
	}
	const status = envelope?.data?.status;
	if (envelope?.ok !== true || envelope?.status !== "observed" || !status) {
		const code = envelope?.error?.code;
		return { kind: "offline", detail: typeof code === "string" ? code : "unavailable" };
	}
	if (envelope.target !== worker.name || status.member?.name !== worker.name || status.member?.role !== worker.role) {
		return { kind: "error", detail: "identity-mismatch" };
	}
	if (
		(status.presence !== "online" && status.presence !== "offline") ||
		typeof status.observedAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(status.observedAt)
	) {
		return { kind: "error", detail: "malformed-status" };
	}
	if (status.presence === "offline") {
		return status.activity === "unavailable" && status.hasPendingMessages === "unavailable"
			? { kind: "offline", detail: "offline" }
			: { kind: "error", detail: "malformed-status" };
	}
	if (typeof status.hasPendingMessages !== "boolean") {
		return { kind: "error", detail: "malformed-status" };
	}
	if (!["idle", "busy", "compacting"].includes(status.activity)) {
		return { kind: "error", detail: "unknown-activity" };
	}
	if (status.activity === "idle" && status.hasPendingMessages === true) {
		return { kind: "busy", detail: "pending-messages" };
	}
	return { kind: status.activity === "idle" ? "idle" : "busy", detail: status.activity };
}
