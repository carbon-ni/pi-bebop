import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { independentReviewerCandidates, parseArgs, probeWorkers, selectWorkers } from "./plan-loop.mjs";

test("runs directly as the pi-auto verifier executable", () => {
	const executable = fileURLToPath(new URL("./plan-loop.mjs", import.meta.url));
	const result = spawnSync(executable, ["--help"], { encoding: "utf8" });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage: node scripts\/plan-loop\.mjs/);
});

test("discovers workers by excluding the configured Intake contact", () => {
	const roster = [
		{ name: "Mary", role: "po" },
		{ name: "Dave", role: "dev" },
		{ name: "Kelly", role: "qa" },
	];

	assert.equal(parseArgs([]).workers, undefined);
	assert.deepEqual(selectWorkers(roster, undefined, "Mary"), [roster[1], roster[2]]);
});

test("never assigns the owner as the independent reviewer", () => {
	const owner = { name: "Dave", role: "dev" };
	assert.deepEqual(independentReviewerCandidates([owner], owner), []);
});

test("blocks finalization when the crew has no independent reviewer", () => {
	const root = mkdtempSync(join(tmpdir(), "plan-loop-"));
	try {
		mkdirSync(join(root, "plans", "todo"), { recursive: true });
		mkdirSync(join(root, "plans", "done"), { recursive: true });
		mkdirSync(join(root, ".pi", "bebop"), { recursive: true });
		writeFileSync(
			join(root, "plans", "todo", "0001-work.md"),
			"---\nid: 1\ntitle: Work\nstatus: doing\ndepends_on: []\n---\n",
		);
		writeFileSync(
			join(root, ".pi", "bebop", "crew.json"),
			JSON.stringify({
				intake: { contact: "Mary" },
				members: [
					{ name: "Mary", role: "po" },
					{ name: "Dave", role: "dev" },
				],
			}),
		);
		const probe = join(root, "fake-bebop.mjs");
		writeFileSync(
			probe,
			`#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,target:"Dave",status:"observed",data:{status:{member:{name:"Dave",role:"dev"},presence:"online",activity:"idle",hasPendingMessages:false,observedAt:"2026-09-22T20:33:46.762Z"}}}));\n`,
		);
		chmodSync(probe, 0o755);

		const executable = fileURLToPath(new URL("./plan-loop.mjs", import.meta.url));
		const result = spawnSync(
			executable,
			["--plans-dir", join(root, "plans"), "--crew-dir", join(root, ".pi", "bebop")],
			{ encoding: "utf8", env: { ...process.env, PI_BEBOP_COMMAND: probe } },
		);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			version: 1,
			reason: "plan 1 has no independent reviewer candidate",
			action: "blocked",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
