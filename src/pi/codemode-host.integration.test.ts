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
			const script =
				'const values = await Promise.allSettled([tools.get_member_status({member: "qa"}), tools.get_member_status({member: "error"})]); const pending = tools.get_member_status({member: "pending"}); let wait = "available"; try { await tools.wait_for_member_idle({member: "qa"}); } catch { wait = "rejected"; } const request = await tools.probe_request_start({}); return { values: values.map((value) => value.status), error: values[1].value?.error, wait, requestId: request.requestId };';
			writeFileSync(join(directory, "settings.json"), `{"codemode":{"mode":"${mode}"}}\n`);
			writeFileSync(
				probe,
				`import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { registerGetMemberStatusTool } from ${JSON.stringify(statusTool)};
import { registerWaitForMemberIdleTool } from ${JSON.stringify(idleWaitTool)};
let pendingAborted = false;
let requestResponse;
const schema = { type: "object", properties: {}, additionalProperties: false };
export default (pi) => {
  registerGetMemberStatusTool(pi, { async getMemberStatus(member, options) { if (member === "pending") return await new Promise((resolve) => { options?.signal?.addEventListener("abort", () => { pendingAborted = true; resolve({ member: { name: member, role: "dev" }, presence: "offline", activity: "unavailable", hasPendingMessages: "unavailable", observedAt: new Date().toISOString() }); }, { once: true }); }); if (member === "error") throw new Error("expected"); return { member: { name: member, role: "dev" }, presence: "online", activity: "idle", hasPendingMessages: false, observedAt: new Date().toISOString() }; } });
  registerWaitForMemberIdleTool(pi, { resolveMemberIdleWait({ member, timeoutSeconds }) { return { target: { name: member, role: "dev" }, timeoutSeconds: timeoutSeconds ?? 60 }; }, async waitForMemberIdle() { throw new Error("not-called"); } });
  pi.registerTool({ name: "probe_request_start", label: "Probe Request Start", description: "request", parameters: schema, outputSchema: schema, executionMode: "parallel", async execute() { setTimeout(() => { requestResponse = { requestId: "request-1", message: "response-after-script" }; }, 25); return { content: [{ type: "text", text: "accepted" }], details: { accepted: true, requestId: "request-1" }, structuredContent: { accepted: true, requestId: "request-1" } }; } });
  pi.registerTool({ name: "probe_pending", label: "Probe Pending", description: "pending", parameters: schema, outputSchema: schema, executionMode: "parallel", async execute(_id, _params, signal) { await new Promise((resolve) => { if (signal?.aborted) { pendingAborted = true; resolve(); return; } signal?.addEventListener("abort", () => { pendingAborted = true; resolve(); }, { once: true }); }); return { content: [{ type: "text", text: "aborted" }], details: { aborted: pendingAborted }, structuredContent: { aborted: pendingAborted } }; } });
  const faux = createFauxCore({ api: "faux-codemode", provider: "faux-codemode", models: [{ id: "probe", name: "Probe" }] });
  pi.registerProvider("faux-codemode", { api: faux.api, models: faux.models, stream: faux.stream, streamSimple: faux.streamSimple });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code: ${JSON.stringify(script)} }), { stopReason: "toolUse" }),
    async (context) => { await new Promise((resolve) => setTimeout(resolve, 50)); const last = context.messages[context.messages.length - 1]; process.stderr.write("CODEMODE_EXECUTION:" + JSON.stringify({ pendingAborted, requestResponse, last }) + "\\n"); return fauxAssistantMessage("done"); },
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
					"codemode,get_member_status,wait_for_member_idle,probe_request_start",
					"-p",
					"run the codemode probe",
				],
				{
					cwd: fileURLToPath(new URL("../..", import.meta.url)),
					env: { ...process.env, HOME: directory, PI_CODING_AGENT_DIR: directory },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => (stderr += chunk));
			const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
			rmSync(directory, { recursive: true, force: true });

			assert.equal(exitCode, 0, stderr);
			const marker = stderr.split("\n").find((line) => line.startsWith("CODEMODE_EXECUTION:"));
			assert.ok(marker, stderr);
			const result = JSON.parse(marker.slice("CODEMODE_EXECUTION:".length)) as {
				pendingAborted: boolean;
				requestResponse?: { requestId: string; message: string };
				last: {
					content: Array<{ type: string; text?: string }>;
					details?: { calls?: Array<{ name: string; status: string }> };
				};
			};
			assert.equal(result.pendingAborted, true);
			assert.deepEqual(result.requestResponse, { requestId: "request-1", message: "response-after-script" });
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
					["probe_request_start", "ok"],
				],
			);
		}
	},
);
