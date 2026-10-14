import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const piPath = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
const runRealHost = process.env.PI_BEBOP_REAL_HOST_TEST === "1";

test(
	"Pi 1.1 host executes codemode with parallel results and cancellation",
	{ skip: !piPath || !runRealHost },
	async () => {
		for (const mode of ["on", "only"] as const) {
			const directory = mkdtempSync(join(tmpdir(), `bebop-codemode-host-${mode}-`));
			const probe = join(directory, "probe.ts");
			const statusTool = fileURLToPath(new URL("../tools/get-member-status.ts", import.meta.url));
			const idleWaitTool = fileURLToPath(new URL("../tools/wait-for-member-idle.ts", import.meta.url));
			const requestTool = fileURLToPath(new URL("../tools/member-request.ts", import.meta.url));
			const requestFlow = fileURLToPath(new URL("../application/member-request-flow.ts", import.meta.url));
			const requestOperation = fileURLToPath(new URL("../sdk/member-request-operation.ts", import.meta.url));
			const script =
				'const values = await Promise.allSettled([tools.get_member_status({member: "qa"}), tools.get_member_status({member: "error"})]); const pending = tools.get_member_status({member: "pending"}); let wait = "available"; try { await tools.wait_for_member_idle({member: "qa"}); } catch { wait = "rejected"; } const request = await tools.send_member_request({member: "peer", message: "report", timeout_seconds: 1, max_wait_seconds: 60}); return { values: values.map((value) => value.status), error: values[1].value?.error, wait, requestId: request.requestId };';
			writeFileSync(join(directory, "settings.json"), `{"codemode":{"mode":"${mode}"}}\n`);
			writeFileSync(
				probe,
				`import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { registerGetMemberStatusTool } from ${JSON.stringify(statusTool)};
import { registerWaitForMemberIdleTool } from ${JSON.stringify(idleWaitTool)};
import { registerSendMemberRequestTool } from ${JSON.stringify(requestTool)};
import { MemberRequestFlow } from ${JSON.stringify(requestFlow)};
import { createInProcessMemberRequestOperation } from ${JSON.stringify(requestOperation)};
let pendingAborted = false;
let requestResponse;
let releaseRequestResponse;
let resolveRequestResponse;
let requestResponseReady = new Promise((resolve) => { resolveRequestResponse = resolve; });
let declaredTools = [];
const statusStarts = [];
let releaseStatuses;
const statusesReady = new Promise((resolve) => { releaseStatuses = resolve; });
const membership = { member: { kind: "member", name: "self", role: "dev", socketPath: "/tmp/self.sock" }, socketPath: "/tmp/self.sock", manifest: { members: [{ kind: "member", name: "self", role: "dev", socketPath: "/tmp/self.sock" }, { kind: "member", name: "peer", role: "dev", socketPath: "/tmp/peer.sock" }] } };
export default (pi) => {
  registerGetMemberStatusTool(pi, { async getMemberStatus(member, options) { if (member === "pending") return await new Promise((resolve) => { options?.signal?.addEventListener("abort", () => { pendingAborted = true; resolve({ member: { name: member, role: "dev" }, presence: "offline", activity: "unavailable", hasPendingMessages: "unavailable", observedAt: new Date().toISOString() }); }, { once: true }); }); if (member === "qa" || member === "error") { statusStarts.push(member); if (statusStarts.length === 2) releaseStatuses(); await statusesReady; } if (member === "error") throw new Error("expected"); return { member: { name: member, role: "dev" }, presence: "online", activity: "idle", hasPendingMessages: false, observedAt: new Date().toISOString() }; } });
  registerWaitForMemberIdleTool(pi, { resolveMemberIdleWait({ member, timeoutSeconds }) { return { target: { name: member, role: "dev" }, timeoutSeconds: timeoutSeconds ?? 60 }; }, async waitForMemberIdle() { throw new Error("not-called"); } });
  const flow = new MemberRequestFlow({ transport: { async open(_endpoint, command, options) { const response = { kind: "response", member: { name: "peer", role: "dev" }, message: "response-after-script", instructions: [] }; const onUpdate = options.onUpdate; releaseRequestResponse = () => { requestResponse = { requestId: command.requestId, message: response.message }; onUpdate(response); resolveRequestResponse(); }; return { close() {} }; }, async respond() {} }, resolveEndpoint: async (socketPath) => socketPath, createRequestId: () => "request-1" });
  const operation = createInProcessMemberRequestOperation({ surface: { getMembership: () => membership, isTrusted: () => true, getMemberRequestFlow: () => flow } });
  registerSendMemberRequestTool(pi, {}, operation);
  const faux = createFauxCore({ api: "faux-codemode", provider: "faux-codemode", models: [{ id: "probe", name: "Probe" }] });
  pi.registerProvider("faux-codemode", { api: faux.api, models: faux.models, stream: faux.stream, streamSimple: faux.streamSimple });
  faux.setResponses([
    (context) => { declaredTools = pi.getActiveTools(); return fauxAssistantMessage(fauxToolCall("codemode", { code: ${JSON.stringify(script)} }), { stopReason: "toolUse" }); },
    async (context) => { releaseRequestResponse?.(); await requestResponseReady; const last = context.messages[context.messages.length - 1]; process.stderr.write("CODEMODE_EXECUTION:" + JSON.stringify({ pendingAborted, requestResponse, statusStarts, declaredTools, last }) + "\\n"); return fauxAssistantMessage("done"); },
  ]);
};\n`,
			);
			const child = spawn(
				"pi",
				[
					"--no-session",
					"--no-extensions",
					"--offline",
					"--extension",
					"builtin:codemode",
					"--extension",
					probe,
					"--model",
					"faux-codemode/probe",
					"--api-key",
					"test",
					"--tools",
					"codemode,get_member_status,wait_for_member_idle,send_member_request",
					"-p",
					"run the codemode probe",
				],
				{
					cwd: fileURLToPath(new URL("../..", import.meta.url)),
					env: Object.fromEntries(
						Object.entries({ ...process.env, HOME: directory, PI_CODING_AGENT_DIR: directory }).filter(
							([key]) => !key.startsWith("npm_"),
						),
					),
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stderr = "";
			let stdout = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => (stderr += chunk));
			const exitCode = await new Promise<number>((resolve) => {
				let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
				const killTimer = setTimeout(() => {
					child.kill("SIGTERM");
					forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
				}, 15_000);
				child.on("close", (code) => {
					clearTimeout(killTimer);
					if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
					resolve(code ?? -1);
				});
			});
			rmSync(directory, { recursive: true, force: true });

			assert.equal(exitCode, 0, stderr);
			const marker = stderr.split("\n").find((line) => line.startsWith("CODEMODE_EXECUTION:"));
			assert.ok(marker, `stdout=${stdout}\nstderr=${stderr}`);
			const result = JSON.parse(marker.slice("CODEMODE_EXECUTION:".length)) as {
				pendingAborted: boolean;
				requestResponse?: { requestId: string; message: string };
				statusStarts: string[];
				declaredTools: string[];
				last: {
					content: Array<{ type: string; text?: string }>;
					details?: { calls?: Array<{ name: string; status: string }> };
				};
			};
			assert.equal(result.pendingAborted, true);
			assert.deepEqual(result.requestResponse, { requestId: "request-1", message: "response-after-script" });
			assert.deepEqual([...result.statusStarts].sort(), ["error", "qa"]);
			assert.equal(
				result.declaredTools.includes("wait_for_member_idle"),
				true,
				JSON.stringify(result.declaredTools),
			);
			const text = result.last.content.map((item) => item.text ?? "").join("\n");
			assert.match(text, /values.*fulfilled.*fulfilled/);
			assert.match(text, /error.*transport-error/);
			assert.match(text, /wait.*rejected/);
			assert.match(text, /requestId.*request-1/);
			assert.deepEqual(
				result.last.details?.calls?.map((call) => [call.name, call.status]),
				[
					["get_member_status", "ok"],
					["get_member_status", "error"],
					["get_member_status", "ok"],
					["send_member_request", "ok"],
				],
			);
		}
	},
);
