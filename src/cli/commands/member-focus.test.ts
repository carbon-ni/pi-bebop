import assert from "node:assert/strict";
import { test } from "node:test";
import {
	memberFocusHelp,
	mapMemberFocusTransportError,
	parseMemberFocusCommand,
	runMemberFocusCommand,
	type MemberFocusCliDependencies,
} from "./member-focus.ts";
import type { CliContext } from "../context.ts";

const context = (input = "stdin focus"): CliContext =>
	({ cwd: "/project", input, signal: new AbortController().signal }) as never;
const deps = (overrides: Partial<MemberFocusCliDependencies> = {}): MemberFocusCliDependencies => ({
	resolveSource: () => ({
		ok: true,
		kind: "id",
		idSocketPath: "/tmp/source.sock",
		aliasSocketPath: "/tmp/source.alias",
	}),
	readStdin: async (input) => input,
	deliverFocus: async (_source, command) => ({
		ok: true,
		result: {
			status: command.action === "clear" ? "cleared" : "updated",
			focus:
				command.action === "clear"
					? { state: "unspecified" }
					: { state: "reported", text: command.focus!, updatedAt: "2026-08-24T00:00:00.000Z" },
		},
	}),
	environmentSession: () => undefined,
	...overrides,
});

test("focus parser preserves dash-leading text only after -- and keeps flags command-local", () => {
	assert.deepEqual(parseMemberFocusCommand(["--session", "lead", "--", "--blocked"], "set", "/project"), {
		command: "member-focus-set",
		action: "set",
		session: "lead",
		focus: "--blocked",
		stdin: false,
		format: "toon",
	});
	assert.throws(() => parseMemberFocusCommand(["--blocked"], "set", "/project"), /requires.*terminator/i);
	assert.throws(() => parseMemberFocusCommand(["--", "  padded"], "set", "/project"), /whitespace/i);
	assert.throws(
		() => parseMemberFocusCommand(["--stdin", "--message"], "set", "/project"),
		/requires.*terminator|Focus text/i,
	);
	assert.deepEqual(parseMemberFocusCommand([], "clear", "/project"), {
		command: "member-focus-clear",
		action: "clear",
		stdin: false,
		format: "toon",
	});
});

test("focus parser covers help, duplicates, missing values, and invalid formats", () => {
	assert.equal(parseMemberFocusCommand(["--help"], "set", "/project").help, true);
	assert.throws(() => parseMemberFocusCommand(["--help", "--help"], "set", "/project"), /Duplicate/);
	assert.throws(() => parseMemberFocusCommand(["--session"], "set", "/project"), /Missing value/);
	assert.throws(() => parseMemberFocusCommand(["--format", "xml"], "set", "/project"), /Invalid --format/);
	assert.throws(() => parseMemberFocusCommand(["--stdin"], "clear", "/project"), /only for/);
	assert.throws(() => parseMemberFocusCommand(["--stdin", "--stdin"], "set", "/project"), /Duplicate/);
	assert.throws(() => parseMemberFocusCommand(["--", "one", "two"], "set", "/project"), /one argument/);
	assert.throws(() => parseMemberFocusCommand(["text"], "clear", "/project"), /does not accept/);
});

test("focus parser rejects unsafe local values before delivery", () => {
	for (const value of ["", " ", "x\ny", "x\0y", "é".repeat(200)])
		assert.throws(() => parseMemberFocusCommand(["--", value], "set", "/project"));
	assert.throws(() => parseMemberFocusCommand(["text", "extra"], "set", "/project"));
});

test("focus transport failures preserve stable offline, malformed, and cancellation codes", async () => {
	const refused = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
	const notConnected = Object.assign(new Error("not connected"), { code: "ENOTCONN" });
	const cancelled = Object.assign(new Error("cancelled"), { name: "AbortError" });
	assert.deepEqual(mapMemberFocusTransportError(refused), { ok: false, code: "offline-session" });
	assert.deepEqual(mapMemberFocusTransportError(notConnected), { ok: false, code: "offline-session" });
	assert.deepEqual(mapMemberFocusTransportError(cancelled), { ok: false, code: "aborted" });
	assert.deepEqual(mapMemberFocusTransportError(new Error("unexpected socket failure")), {
		ok: false,
		code: "transport-error",
	});
	for (const code of ["offline-session", "malformed-response", "aborted"]) {
		const outcome = await runMemberFocusCommand(
			{ command: "member-focus-set", action: "set", focus: "Working", stdin: false, format: "json" },
			context(),
			deps({ deliverFocus: async () => ({ ok: false, code }) }),
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") assert.equal(outcome.result.error?.code, code);
	}
});

test("focus command maps source resolution and stdin outcomes", async () => {
	const sourceFailure = await runMemberFocusCommand(
		{ command: "member-focus-set", action: "set", focus: "Working", stdin: false, format: "json" },
		context(),
		deps({ resolveSource: () => ({ ok: false, code: "missing-session", message: "missing" }) }),
	);
	assert.equal(sourceFailure.kind, "result");
	const stdin = await runMemberFocusCommand(
		{ command: "member-focus-set", action: "set", stdin: true, format: "json" },
		context("From stdin"),
		deps(),
	);
	assert.equal(stdin.kind, "result");
});

test("focus help and result semantics are explicit and self-scoped", async () => {
	assert.match(memberFocusHelp("set"), /self-reported and unverified/i);
	assert.match(memberFocusHelp("set"), /-- --blocked/);
	const set = await runMemberFocusCommand(
		{ command: "member-focus-set", action: "set", focus: "Working", stdin: false, format: "json" },
		context(),
		deps(),
	);
	assert.equal(set.kind, "result");
	if (set.kind === "result") assert.equal(set.result.status, "updated");
	const clear = await runMemberFocusCommand(
		{ command: "member-focus-clear", action: "clear", stdin: false, format: "json" },
		context(),
		deps({
			deliverFocus: async () => ({ ok: true, result: { status: "unchanged", focus: { state: "unspecified" } } }),
		}),
	);
	assert.equal(clear.kind, "result");
	if (clear.kind === "result") assert.equal(clear.result.status, "unchanged");
});
