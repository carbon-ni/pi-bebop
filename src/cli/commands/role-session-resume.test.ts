import assert from "node:assert/strict";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { runRoleSessionResumeCommand } from "./role-session-resume.ts";
import type { RoleSessionCandidate } from "../../application/role-session-resume.ts";
import type { CliContext } from "../support/context.ts";
import { runCli } from "../run.ts";

const execFile = promisify(execFileCallback);

const candidate: RoleSessionCandidate = {
	sessionId: "session-1",
	sessionFile: "/sessions/one.jsonl",
	cwd: "/original/project",
	root: "/sessions",
	name: "One",
	modified: "2026-09-12T10:00:00.000Z",
};

function context(): CliContext {
	return {
		cwd: "/project",
		input: new PassThrough(),
		output: new PassThrough(),
		signal: new AbortController().signal,
		environment: { PI_SESSION_ID: "current" },
	};
}

test("empty discovery and picker cancellation are successful bounded outcomes", async () => {
	const empty = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "toon", full: false },
		context(),
		{
			discover: async () => ({
				ok: true as const,
				member: { name: "Alice", role: "developer", socketPath: "/crew/alice.sock" },
				candidates: [],
				skipped: 2,
			}),
			resolve: async () => ({ ok: true as const, candidate }),
			pick: async () => ({ kind: "selected" as const, candidate }),
			launcher: { launch: async () => ({ ok: true as const, exitCode: 0 }) },
		},
	);
	assert.equal(empty.kind, "result");
	if (empty.kind === "result") assert.equal(empty.result.status, "empty");
	const cancelled = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "toon", full: false },
		context(),
		{
			discover: async () => ({
				ok: true as const,
				member: { name: "Alice", role: "developer", socketPath: "/crew/alice.sock" },
				candidates: [candidate],
				skipped: 0,
			}),
			resolve: async () => ({ ok: true as const, candidate }),
			pick: async () => ({ kind: "cancelled" as const }),
			launcher: { launch: async () => ({ ok: true as const, exitCode: 0 }) },
		},
	);
	assert.equal(cancelled.kind, "result");
	if (cancelled.kind === "result") assert.equal(cancelled.result.status, "cancelled");
});

test("bounded failures never launch", async () => {
	const failure = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "toon", full: false },
		context(),
		{
			discover: async () => ({ ok: false as const, code: "session-scan-failed", message: "scan failed" }),
			resolve: async () => ({ ok: true as const, candidate }),
			pick: async () => ({ kind: "selected" as const, candidate }),
			launcher: { launch: async () => ({ ok: true as const, exitCode: 0 }) },
		},
	);
	assert.equal(failure.kind, "result");
	if (failure.kind === "result") assert.equal(failure.result.error?.code, "session-scan-failed");
	const thrownError = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "toon", full: false },
		context(),
		{
			discover: async () => {
				throw new Error("unexpected");
			},
			resolve: async () => ({ ok: true as const, candidate }),
			pick: async () => ({ kind: "selected" as const, candidate }),
			launcher: { launch: async () => ({ ok: true as const, exitCode: 0 }) },
		},
	);
	assert.equal(thrownError.kind, "result");
	if (thrownError.kind === "result") assert.equal(thrownError.result.error?.message, "unexpected");
	const thrownValue = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "toon", full: false },
		context(),
		{
			discover: async () => {
				throw "unexpected value";
			},
			resolve: async () => ({ ok: true as const, candidate }),
			pick: async () => ({ kind: "selected" as const, candidate }),
			launcher: { launch: async () => ({ ok: true as const, exitCode: 0 }) },
		},
	);
	assert.equal(thrownValue.kind, "result");
	if (thrownValue.kind === "result") assert.equal(thrownValue.result.error?.message, "Role Session resume failed");
});

test("picks, revalidates, and launches exactly one selected Pi session", async () => {
	let launch: unknown;
	const outcome = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "json", full: false },
		context(),
		{
			discover: async () => ({
				ok: true,
				member: { name: "Alice", role: "developer", socketPath: "/crew/alice.sock" },
				candidates: [candidate],
				skipped: 2,
			}),
			resolve: async ({ candidate: selected }) => ({ ok: true, candidate: selected }),
			pick: async () => ({ kind: "selected", candidate }),
			launcher: {
				launch: async (request) => {
					launch = request;
					return { ok: true, exitCode: 0 };
				},
			},
		},
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") {
		assert.equal(outcome.result.status, "resumed");
		assert.equal(outcome.result.ok, true);
	}
	assert.deepEqual(launch, {
		sessionFile: "/sessions/one.jsonl",
		cwd: "/original/project",
		environment: { PI_SESSION_ID: "current" },
	});
});

test("stale and malformed selected evidence never spawns Pi", async () => {
	const failureCodes = [
		"missing-session-file",
		"malformed-session",
		"untrusted-session-root",
		"session-id-mismatch",
		"session-cwd-mismatch",
	] as const;
	let launches = 0;
	for (const code of failureCodes) {
		const outcome = await runRoleSessionResumeCommand(
			{ command: "session-resume", role: "developer", format: "toon", full: false },
			context(),
			{
				discover: async () => ({
					ok: true as const,
					member: { name: "Alice", role: "developer", socketPath: "/crew/alice.sock" },
					candidates: [candidate],
					skipped: 0,
				}),
				resolve: async () => ({ ok: false as const, code, message: `rejected: ${code}` }),
				pick: async () => ({ kind: "selected" as const, candidate }),
				launcher: {
					launch: async () => {
						launches += 1;
						return { ok: true as const, exitCode: 0 };
					},
				},
			},
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") assert.equal(outcome.result.error?.code, code);
	}
	assert.equal(launches, 0);
});

test("resolution and launch failures stay bounded", async () => {
	const resolvedFailure = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "toon", full: false },
		context(),
		{
			discover: async () => ({
				ok: true as const,
				member: { name: "Alice", role: "developer", socketPath: "/crew/alice.sock" },
				candidates: [candidate],
				skipped: 0,
			}),
			resolve: async () => ({ ok: false as const, code: "already-online", message: "already online" }),
			pick: async () => ({ kind: "selected" as const, candidate }),
			launcher: { launch: async () => ({ ok: true as const, exitCode: 0 }) },
		},
	);
	assert.equal(resolvedFailure.kind, "result");
	if (resolvedFailure.kind === "result") assert.equal(resolvedFailure.result.error?.code, "already-online");

	const launchFailure = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "toon", full: false },
		context(),
		{
			discover: async () => ({
				ok: true as const,
				member: { name: "Alice", role: "developer", socketPath: "/crew/alice.sock" },
				candidates: [candidate],
				skipped: 0,
			}),
			resolve: async () => ({ ok: true as const, candidate }),
			pick: async () => ({ kind: "selected" as const, candidate }),
			launcher: { launch: async () => ({ ok: false as const, code: "spawn-failed", message: "spawn failed" }) },
		},
	);
	assert.equal(launchFailure.kind, "result");
	if (launchFailure.kind === "result") assert.equal(launchFailure.result.error?.code, "spawn-failed");
});

test("selected sessions without names use the stable session id and default output", async () => {
	const unnamed = { ...candidate, name: undefined };
	const outcome = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "text", full: false },
		{ ...context(), output: undefined },
		{
			discover: async () => ({
				ok: true as const,
				member: { name: "Alice", role: "developer", socketPath: "/crew/alice.sock" },
				candidates: [unnamed],
				skipped: 0,
			}),
			resolve: async () => ({ ok: true as const, candidate: unnamed }),
			pick: async (_candidates, _input, output) => {
				output.write("");
				return { kind: "selected" as const, candidate: unnamed };
			},
			launcher: { launch: async () => ({ ok: true as const, exitCode: 0 }) },
		},
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.response, "Resumed session-1");
});

test("plain Pi -r remains Pi's native resume picker surface", async () => {
	const { stdout } = await execFile("pi", ["-r", "--help"]);
	assert.match(stdout, /Select a session to resume/);
	assert.doesNotMatch(stdout, /role-attributed|session resume --role/i);
});

test("the real CLI keeps resume help, syntax errors, and failures inside the stream contract", async () => {
	const helpOutput = new PassThrough();
	const helpErr = new PassThrough();
	let helpText = "";
	let helpErrText = "";
	helpOutput.on("data", (chunk) => {
		helpText += chunk;
	});
	helpErr.on("data", (chunk) => {
		helpErrText += chunk;
	});
	assert.equal(await runCli(["session", "resume", "--help"], "/project", process.stdin, helpOutput, helpErr), 0);
	assert.match(helpText, /Usage: pi-bebop session resume/);
	assert.match(helpText, /--role <exact-role>/);
	assert.equal(helpErrText, "");

	const errorOutput = new PassThrough();
	const errorErr = new PassThrough();
	let errorText = "";
	let errorErrText = "";
	errorOutput.on("data", (chunk) => {
		errorText += chunk;
	});
	errorErr.on("data", (chunk) => {
		errorErrText += chunk;
	});
	assert.equal(
		await runCli(
			["session", "resume", "--role", "developer", "--unknown"],
			"/project",
			process.stdin,
			errorOutput,
			errorErr,
		),
		2,
	);
	assert.equal(errorText, "");
	assert.match(errorErrText, /unknown option '--unknown'/i);

	const operationalOutput = new PassThrough();
	const operationalErr = new PassThrough();
	let operationalText = "";
	let operationalErrText = "";
	operationalOutput.on("data", (chunk) => {
		operationalText += chunk;
	});
	operationalErr.on("data", (chunk) => {
		operationalErrText += chunk;
	});
	assert.equal(
		await runCli(
			["session", "resume", "--role", "developer", "--format", "text"],
			"/project",
			process.stdin,
			operationalOutput,
			operationalErr,
		),
		1,
	);
	assert.equal(operationalText, "");
	assert.match(operationalErrText, /no supported Crew manifest/i);
});

test("empty and cancelled selections never launch or fall back", async () => {
	let launches = 0;
	const base = {
		discover: async () => ({
			ok: true as const,
			member: { name: "Alice", role: "developer", socketPath: "/crew/alice.sock" },
			candidates: [],
			skipped: 1,
		}),
		resolve: async () => ({ ok: true as const, candidate }),
		pick: async () => ({ kind: "cancelled" as const }),
		launcher: {
			launch: async () => {
				launches += 1;
				return { ok: true as const, exitCode: 0 };
			},
		},
	};
	const empty = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "toon", full: false },
		context(),
		base,
	);
	assert.equal(empty.kind, "result");
	if (empty.kind === "result") assert.equal(empty.result.status, "empty");
	const cancelled = await runRoleSessionResumeCommand(
		{ command: "session-resume", role: "developer", format: "toon", full: false },
		context(),
		{ ...base, discover: async () => ({ ...(await base.discover()), candidates: [candidate] }) },
	);
	assert.equal(cancelled.kind, "result");
	if (cancelled.kind === "result") assert.equal(cancelled.result.status, "cancelled");
	assert.equal(launches, 0);
});
