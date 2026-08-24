import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildMemberInterruptCommand,
	defaultMemberInterruptCliDependencies,
	memberInterruptHelp,
	parseMemberInterruptCommand,
	runMemberInterruptCommand,
	type MemberInterruptCliDependencies,
} from "./member-interrupt.ts";
import type { CliContext } from "../context.ts";

function context(): CliContext {
	return { cwd: "/project", input: "stdin recovery", signal: new AbortController().signal } as never;
}
function deps(overrides: Partial<MemberInterruptCliDependencies> = {}): MemberInterruptCliDependencies {
	return {
		resolveSource: () => ({
			ok: true,
			kind: "id",
			idSocketPath: "/tmp/source.sock",
			aliasSocketPath: "/tmp/source.alias",
		}),
		readStdin: async () => "stdin recovery",
		deliverInterrupt: async (_source, _command) => ({
			ok: true,
			result: { member: { name: "Kelly", role: "qa" }, interruptId: "interrupt-1", disposition: "direct" },
		}),
		environmentSession: () => undefined,
		...overrides,
	};
}

test("interrupt parser enforces message source, preserves instructions, and supports source selection", () => {
	const parsed = parseMemberInterruptCommand(
		["Kelly", "--session", "source-1", "--message", "stop", "--instruction", "first", "--instruction", "second"],
		"/project",
	);
	assert.deepEqual(parsed, {
		command: "member-interrupt",
		member: "Kelly",
		session: "source-1",
		message: "stop",
		instructions: ["first", "second"],
		stdin: false,
		format: "toon",
	});
	assert.throws(() => parseMemberInterruptCommand(["Kelly", "--message", "x", "--stdin"], "/project"), /exactly one/);
});

test("interrupt default transport maps an unavailable endpoint", async () => {
	const outcome = await defaultMemberInterruptCliDependencies.deliverInterrupt(
		{
			ok: true,
			kind: "id",
			idSocketPath: "/tmp/missing-interrupt.sock",
			aliasSocketPath: "/tmp/missing-interrupt.alias",
		},
		{ type: "member_interrupt", target: "Kelly", message: "stop" },
		new AbortController().signal,
	);
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.equal(outcome.code, "unknown-session");
});

test("interrupt help states hard-recovery best-effort and no-rollback semantics", () => {
	assert.match(memberInterruptHelp(), /stuck, harmful/i);
	assert.match(memberInterruptHelp(), /best-effort/i);
	assert.match(memberInterruptHelp(), /cannot roll back/i);
	assert.equal(buildMemberInterruptCommand().name(), "interrupt");
});

test("interrupt CLI returns disposition without completion claims and preserves stable errors", async () => {
	const direct = await runMemberInterruptCommand(
		{
			command: "member-interrupt",
			member: "Kelly",
			message: "stop",
			instructions: [],
			stdin: false,
			format: "json",
		},
		context(),
		deps(),
	);
	assert.equal(direct.kind, "result");
	if (direct.kind !== "result") return;
	assert.equal(direct.result.status, "accepted");
	assert.equal((direct.result.data as { disposition: string }).disposition, "direct");
	assert.doesNotMatch(JSON.stringify(direct.result), /complete|undone|rolled back/i);

	const busy = await runMemberInterruptCommand(
		{
			command: "member-interrupt",
			member: "Kelly",
			message: "stop",
			instructions: [],
			stdin: false,
			format: "json",
		},
		context(),
		deps({
			deliverInterrupt: async () => ({
				ok: true,
				result: {
					member: { name: "Kelly", role: "qa" },
					interruptId: "interrupt-2",
					disposition: "interrupt-requested",
				},
			}),
		}),
	);
	assert.equal(busy.kind, "result");
	if (busy.kind === "result")
		assert.equal((busy.result.data as { disposition: string }).disposition, "interrupt-requested");

	const rejected = await runMemberInterruptCommand(
		{
			command: "member-interrupt",
			member: "Kelly",
			message: "stop",
			instructions: [],
			stdin: false,
			format: "json",
		},
		context(),
		deps({ deliverInterrupt: async () => ({ ok: false, code: "timeout" }) }),
	);
	assert.equal(rejected.kind, "result");
	if (rejected.kind === "result") assert.equal(rejected.result.error?.code, "timeout");
});
