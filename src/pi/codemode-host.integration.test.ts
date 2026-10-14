import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runRealHost = process.env.PI_BEBOP_REAL_HOST_TEST === "1";
const root = fileURLToPath(new URL("../..", import.meta.url));
const source = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));

const requestScript = `
const values = await Promise.all([
  tools.get_member_status({ member: "qa" }),
  tools.get_member_status({ member: "error" }),
]);
const settled = await Promise.allSettled([
  tools.get_member_status({ member: "other" }),
  tools.get_member_status({}),
]);
const blocked = [];
for (const name of ["wait_for_member_idle", "wait_for_request_outcome"]) {
  try { await tools[name]({ member: "qa", request_id: "request-1" }); }
  catch { blocked.push(name); }
}
const requests = await Promise.all([
  tools.send_member_request({ member: "peer", message: "first report" }),
  tools.send_member_request({ member: "peer", message: "second report" }),
]);
return { member: values[0].status.member.name, error: values[1].error,
  settled: settled.map(value => value.status), blocked, requestIds: requests.map(value => value.requestId) };
`;

const cancellationScript = `
const pending = tools.send_member_request({ member: "cancel", message: "cancel me" });
await tools.get_member_status({ member: "cancel-barrier" });
return "pending request started";
`;

function probeSource(): string {
	return `
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai/compat";
import { registerGetMemberStatusTool } from ${source("../tools/get-member-status.ts")};
import { registerWaitForMemberIdleTool } from ${source("../tools/wait-for-member-idle.ts")};
import { registerSendMemberRequestTool, registerWaitForRequestOutcomeTool } from ${source("../tools/member-request.ts")};
import { MemberRequestFlow } from ${source("../application/member-request-flow.ts")};
import { createInProcessMemberRequestOperation } from ${source("../sdk/member-request-operation.ts")};
import { createSocketState } from ${source("./control-runtime.ts")};

const observedAt = "2026-01-09T12:00:00.000Z";
const statusStarts = [];
let releaseStatuses;
const statusesReady = new Promise(resolve => { releaseStatuses = resolve; });
let releaseCancellation;
const cancellationStarted = new Promise(resolve => { releaseCancellation = resolve; });
const timers = new Set();
let nextTimer = 0;
let nextRequest = 0;
let cancelled = false;
let channelClosed = false;
const responses = new Map();
let releaseRequests;
const requestsReady = new Promise(resolve => { releaseRequests = resolve; });
let declaredTools;
let scriptResult;
const responseResults = [];
let acceptedState;
let idleWaitCalls = 0;

export default pi => {
  const members = ["self", "peer", "cancel"].map(name => ({
    kind: "member", name, role: "dev", socketPath: "/private/" + name + ".sock",
  }));
  const membership = { member: members[0], socketPath: members[0].socketPath, manifest: { members } };
  const flow = new MemberRequestFlow({
    now: () => 1000,
    createRequestId: () => "request-" + ++nextRequest,
    setTimeout: () => { const timer = ++nextTimer; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    resolveEndpoint: async socketPath => socketPath,
    transport: {
      async open(endpoint, command, options) {
        if (endpoint.endsWith("cancel.sock")) {
          return await new Promise((_resolve, reject) => {
            const abort = () => {
              cancelled = true;
              const error = new Error("cancelled"); error.name = "AbortError";
              reject(error);
            };
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener("abort", abort, { once: true });
            releaseCancellation();
          });
        }
        responses.set(command.requestId, () => options.onUpdate({
          kind: "response", member: { name: "peer", role: "dev" },
          message: "response-after-script:" + command.requestId, instructions: ["verified response"],
        }));
        if (responses.size === 2) releaseRequests();
        await requestsReady;
        return { close() { channelClosed = true; } };
      },
      async respond() {},
    },
  });
  const state = createSocketState();
  state.memberRequestFlow = flow;
  const operation = createInProcessMemberRequestOperation({ surface: {
    getMembership: () => membership, isTrusted: () => true, getMemberRequestFlow: () => flow,
  } });
  registerSendMemberRequestTool(pi, state, operation);
  registerWaitForRequestOutcomeTool(pi, state, operation);
  registerWaitForMemberIdleTool(pi, {
    resolveMemberIdleWait({ member, timeoutSeconds }) {
      return { target: { name: member, role: "dev" }, timeoutSeconds: timeoutSeconds ?? 60 };
    },
    async waitForMemberIdle() { idleWaitCalls++; throw new Error("nested wait dispatched"); },
  });
  registerGetMemberStatusTool(pi, {
    async getMemberStatus(member) {
      if (member === "cancel-barrier") await cancellationStarted;
      if (member === "qa" || member === "error") {
        statusStarts.push(member);
        if (statusStarts.length === 2) releaseStatuses();
        await statusesReady;
      }
      if (member === "error") throw new Error("expected semantic error");
      return { member: { name: member, role: "dev" }, presence: "online", activity: "idle",
        hasPendingMessages: false, observedAt };
    },
  });

  const faux = createFauxCore({ api: "faux-codemode", provider: "faux-codemode",
    models: [{ id: "probe", name: "Probe" }] });
  pi.registerProvider("faux-codemode", { api: faux.api, models: faux.models,
    stream: faux.stream, streamSimple: faux.streamSimple });
  faux.setResponses([
    context => {
      declaredTools = getCurrentTools(context.messages).map(tool => tool.name);
      return fauxAssistantMessage(fauxToolCall("codemode", { code: ${JSON.stringify(requestScript)} }), { stopReason: "toolUse" });
    },
    context => {
      scriptResult = context.messages.at(-1);
      acceptedState = { outbound: flow.listRequestSummaries("outbound").length, timers: timers.size, channelClosed };
      responses.get("request-2")();
      responses.get("request-1")();
      return fauxAssistantMessage(fauxToolCall("wait_for_request_outcome", { request_id: "request-1" }), { stopReason: "toolUse" });
    },
    context => {
      responseResults.push(context.messages.at(-1));
      return fauxAssistantMessage(fauxToolCall("wait_for_request_outcome", { request_id: "request-2" }), { stopReason: "toolUse" });
    },
    context => {
      responseResults.push(context.messages.at(-1));
      return fauxAssistantMessage(fauxToolCall("codemode", { code: ${JSON.stringify(cancellationScript)} }), { stopReason: "toolUse" });
    },
    context => {
      process.stderr.write("CODEMODE_EXECUTION:" + JSON.stringify({ declaredTools, statusStarts,
        scriptResult, responseResults, acceptedState, cancelled, channelClosed, idleWaitCalls,
        outbound: flow.listRequestSummaries("outbound").length,
        pendingOutcome: flow.hasPendingRequestOutcome(), timers: timers.size,
        cancellationResult: context.messages.at(-1) }) + "\\n");
      return fauxAssistantMessage("done");
    },
  ]);
};
`;
}

function runHost(directory: string, probe: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
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
				"codemode,get_member_status,wait_for_member_idle,wait_for_request_outcome,send_member_request",
				"-p",
				"run the codemode probe",
			],
			{
				cwd: root,
				env: Object.fromEntries(
					Object.entries({ ...process.env, HOME: directory, PI_CODING_AGENT_DIR: directory }).filter(
						([key]) => !key.startsWith("npm_"),
					),
				),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		const killTimer = setTimeout(() => {
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
		}, 15_000);
		const cleanup = () => {
			clearTimeout(killTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
		};
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("close", (code) => {
			cleanup();
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

for (const mode of ["on", "only"] as const) {
	test(
		`Pi 1.1 codemode ${mode} preserves Bebop results, request lifetime and direct waits`,
		{ skip: !runRealHost },
		async () => {
			const version = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 });
			assert.equal(version.status, 0, "Explicit host verification requires Pi 1.1 on PATH");
			assert.match(version.stdout.trim(), /^1\.1\./, "This host contract gate targets Pi 1.1.x");
			const directory = mkdtempSync(join(tmpdir(), `bebop-codemode-host-${mode}-`));
			try {
				const probe = join(directory, "probe.ts");
				writeFileSync(join(directory, "settings.json"), JSON.stringify({ codemode: { mode } }));
				writeFileSync(probe, probeSource());
				const child = await runHost(directory, probe);
				assert.equal(child.code, 0, child.stderr);
				const marker = child.stderr.split("\n").find((line) => line.startsWith("CODEMODE_EXECUTION:"));
				assert.ok(marker, `stdout=${child.stdout}\nstderr=${child.stderr}`);
				const result = JSON.parse(marker.slice("CODEMODE_EXECUTION:".length));
				const textOf = (message: { content: Array<{ text?: string }> }) =>
					message.content.map((item) => item.text ?? "").join("\n");
				const scriptText = textOf(result.scriptResult);

				assert.deepEqual([...result.statusStarts].sort(), ["error", "qa"]);
				assert.match(scriptText, /"member":\s*"qa"/);
				assert.match(scriptText, /"error":\s*"transport-error"/);
				assert.match(scriptText, /"settled":\s*\["fulfilled","rejected"\]/);
				assert.match(scriptText, /"blocked":\s*\["wait_for_member_idle","wait_for_request_outcome"\]/);
				assert.match(scriptText, /"requestIds":\s*\["request-1","request-2"\]/);
				assert.doesNotMatch(scriptText, /\/private\//);
				for (const wait of ["wait_for_member_idle", "wait_for_request_outcome"]) {
					assert.ok(result.declaredTools.includes(wait), `${wait} must remain model-declared in ${mode}`);
				}
				assert.equal(result.declaredTools.includes("get_member_status"), mode === "on");
				assert.equal(result.idleWaitCalls, 0);
				assert.deepEqual(result.acceptedState, { outbound: 2, timers: 2, channelClosed: false });
				assert.equal(result.responseResults.length, 2);
				for (const [index, response] of result.responseResults.entries()) {
					assert.ok(textOf(response).includes(`response-after-script:request-${index + 1}`));
					assert.match(textOf(response), /verified response/);
					assert.equal(response.isError, false);
				}
				assert.equal(result.cancelled, true);
				assert.equal(result.channelClosed, true);
				assert.equal(result.outbound, 0);
				assert.equal(result.pendingOutcome, false);
				assert.equal(result.timers, 0);
				assert.match(textOf(result.cancellationResult), /Script completed/);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
}
