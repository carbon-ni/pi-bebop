import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const piPath = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
const runRealHost = process.env.PI_BEBOP_REAL_HOST_TEST === "1";

test("Pi 1.1 host loads Bebop exposure boundaries", { skip: !piPath || !runRealHost }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "bebop-codemode-host-"));
	const probe = join(directory, "probe.ts");
	writeFileSync(
		probe,
		`export default (pi) => {
  pi.on("session_start", (_event, ctx) => {
    const names = new Set(["get_member_status", "send_follow_up", "send_member_request", "wait_for_member_idle", "wait_for_request_outcome"]);
    const tools = (ctx.getAllTools?.() ?? pi.getAllTools?.() ?? []).filter((tool) => names.has(tool.name)).map((tool) => ({ name: tool.name, exposure: tool.exposure }));
    process.stderr.write("BEBOP_CODEMODE_PROBE:" + JSON.stringify(tools) + "\\n");
  });
};\n`,
	);
	const extension = fileURLToPath(new URL("../extension.ts", import.meta.url));
	const child = spawn(
		"pi",
		[
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--offline",
			"--extension",
			extension,
			"--extension",
			probe,
		],
		{
			cwd: fileURLToPath(new URL("../..", import.meta.url)),
			env: { ...process.env, HOME: directory, PI_CODING_AGENT_DIR: directory },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.stdin.end('{"id":"probe","type":"get_state"}\n');
	const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
	rmSync(directory, { recursive: true, force: true });

	assert.equal(exitCode, 0, stderr);
	const marker = stderr.split("\n").find((line) => line.startsWith("BEBOP_CODEMODE_PROBE:"));
	assert.ok(marker, stderr);
	const tools = JSON.parse(marker.slice("BEBOP_CODEMODE_PROBE:".length)) as Array<{
		name: string;
		exposure: string;
	}>;
	assert.deepEqual(
		tools.sort((left, right) => left.name.localeCompare(right.name)),
		[
			{ name: "get_member_status", exposure: "direct" },
			{ name: "send_follow_up", exposure: "direct" },
			{ name: "send_member_request", exposure: "direct" },
			{ name: "wait_for_member_idle", exposure: "model-only" },
			{ name: "wait_for_request_outcome", exposure: "model-only" },
		],
	);
});
