import assert from "node:assert/strict";
import { test } from "node:test";
import {
	memberFocusHelp,
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

test("focus parser rejects unsafe local values before delivery", () => {
	for (const value of ["", " ", "x\ny", "x\0y", "é".repeat(200)])
		assert.throws(() => parseMemberFocusCommand(["--", value], "set", "/project"));
	assert.throws(() => parseMemberFocusCommand(["text", "extra"], "set", "/project"));
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
