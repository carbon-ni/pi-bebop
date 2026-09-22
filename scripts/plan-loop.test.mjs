import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, probeWorkers } from "./plan-loop.mjs";

test("runs directly as the pi-auto verifier executable", () => {
	const executable = fileURLToPath(new URL("./plan-loop.mjs", import.meta.url));
	const result = spawnSync(executable, ["--help"], { encoding: "utf8" });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage: node scripts\/plan-loop\.mjs/);
});

test("parses an explicit source session", () => {
	assert.equal(parseArgs(["--session", "source-session"]).session, "source-session");
});

test("passes the explicit source session to every member status probe", async () => {
	const calls = [];
	const workers = [
		{ name: "Dave", role: "dev" },
		{ name: "Kelly", role: "qa" },
	];

	await probeWorkers(workers, {
		session: "source-session",
		timeoutMs: 1234,
		probe: async (worker, options) => {
			calls.push({ worker, options });
			return { kind: "idle", detail: "idle" };
		},
	});

	assert.deepEqual(
		calls.map(({ worker, options }) => ({
			name: worker.name,
			session: options.session,
			timeoutMs: options.timeoutMs,
		})),
		[
			{ name: "Dave", session: "source-session", timeoutMs: 1234 },
			{ name: "Kelly", session: "source-session", timeoutMs: 1234 },
		],
	);
});
