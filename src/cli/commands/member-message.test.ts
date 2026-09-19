import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
	buildMemberMessageCommand,
	defaultMemberMessageCliDependencies,
	readMemberMessageCommand,
	runMemberMessageCommand,
	type MemberMessageCliDependencies,
	type MemberMessageIntent,
} from "./member-message.ts";
import { UsageError } from "../support/arguments.ts";
import { writeOutcome, type CliOutcome } from "../support/output.ts";
import type { CliContext } from "../support/context.ts";
import type { SourceResolution } from "../support/source-session.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

function okSource(): SourceResolution & { ok: true } {
	return { ok: true, kind: "id", idSocketPath: "/bebop/s-1.sock", aliasSocketPath: "/bebop/s-1.alias" };
}

const QUEUED = {
	member: { name: "Kelly", role: "qa" },
	deliveryId: "delivery-1",
	disposition: "queued",
};

function deps(overrides: Partial<MemberMessageCliDependencies> = {}): MemberMessageCliDependencies {
	return {
		resolveSource: () => okSource(),
		readStdin: async () => "stdin text",
		deliverMessage: async () => ({ ok: true, result: QUEUED }),
		environmentSession: () => undefined,
		...overrides,
	};
}

function render(outcome: CliOutcome): { exit: number; text: string } {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const exit = writeOutcome(output, new PassThrough(), outcome);
	return { exit, text };
}

function parseInto(intent: MemberMessageIntent, tokens: readonly string[]) {
	const command = buildMemberMessageCommand(intent)
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return readMemberMessageCommand(command, intent);
}

function options(intent: MemberMessageIntent, overrides: Record<string, unknown> = {}) {
	return {
		command: intent === "follow_up" ? "member-follow-up" : "member-redirect",
		intent,
		member: "Kelly",
		message: "wrap up",
		instructions: [],
		stdin: false,
		format: "toon",
		...overrides,
	} as never;
}

// --- parse: both intents ---

// --- read: canonical Commander grammar and semantic validation ---

test("member message default transport maps stale id and alias sockets", async () => {
	const command = { type: "member_follow_up" as const, target: "Kelly", message: "hello", instructions: [] };
	const same = await defaultMemberMessageCliDependencies.deliverMessage(
		{
			ok: true,
			kind: "id",
			idSocketPath: "/tmp/missing-message.sock",
			aliasSocketPath: "/tmp/missing-message.sock",
		},
		command,
		new AbortController().signal,
	);
	assert.deepEqual(same, { ok: false, code: "unknown-session" });
	const fallback = await defaultMemberMessageCliDependencies.deliverMessage(
		{
			ok: true,
			kind: "id",
			idSocketPath: "/tmp/missing-message-id.sock",
			aliasSocketPath: "/tmp/missing-message-alias.sock",
		},
		command,
		new AbortController().signal,
	);
	assert.deepEqual(fallback, { ok: false, code: "unknown-session" });
});

test("member message dependencies read explicit environment sessions and process fallback", () => {
	assert.equal(defaultMemberMessageCliDependencies.environmentSession({ PI_SESSION_ID: "env-1" }), "env-1");
	const processSession = defaultMemberMessageCliDependencies.environmentSession();
	assert.ok(processSession === undefined || typeof processSession === "string");
});

test("member message readers preserve intent and source options", () => {
	assert.deepEqual(parseInto("follow_up", ["Kelly", "--message", "wrap up", "--instruction", "one"]), {
		command: "member-follow-up",
		intent: "follow_up",
		member: "Kelly",
		message: "wrap up",
		instructions: ["one"],
		stdin: false,
		format: "toon",
	});
	const redirect = parseInto("redirect", ["Kelly", "--stdin", "--format", "text", "--session", "source-1"]);
	assert.equal(redirect.intent, "redirect");
	assert.equal(redirect.session, "source-1");
});

test("member message readers reject invalid target, format, and message sources", () => {
	for (const tokens of [
		["--message", "hello"],
		[" Kelly", "--message", "hello"],
		["Kelly", "--format", "yaml", "--message", "hello"],
		["Kelly"],
		["Kelly", "--message", "hello", "--stdin"],
		["Kelly", "--message", "   "],
		["Kelly", "--message", "hello\0world"],
	] as const)
		assert.throws(() => parseInto("follow_up", tokens), UsageError);
});

test("member message readers reject malformed instructions and oversized content", () => {
	assert.throws(() => parseInto("follow_up", ["Kelly", "--stdin", "--instruction", " padded "]), /trimmed/);
	assert.throws(() => parseInto("follow_up", ["Kelly", "--stdin", "--instruction", "bad\0value"]), /NUL/);
	assert.throws(
		() => parseInto("follow_up", ["Kelly", "--stdin", "--instruction", "x".repeat(100_001)]),
		/100000-byte/,
	);
	const tooMany = ["Kelly", "--stdin"];
	for (let i = 0; i < 33; i++) tooMany.push("--instruction", String(i));
	assert.throws(() => parseInto("follow_up", tooMany), /maximum is 32/);
	assert.throws(() => parseInto("follow_up", ["Kelly", "--message", "x".repeat(1_000_001)]), /message limit/);
});

// --- run: source selection + delivery outcomes ---

test("member message run: stdin read failures become stable operational results", async () => {
	const outcome = await runMemberMessageCommand(
		options("follow_up", { stdin: true }),
		context(),
		deps({
			readStdin: async () => {
				throw new Error("stdin unavailable");
			},
		}),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "stdin-error");
});

test("member message run: session-required and invalid-session are usage-class failures", async () => {
	for (const code of ["session-required", "invalid-session"] as const) {
		const dependencies = deps({ resolveSource: () => ({ ok: false, code, message: "boom" }) });
		await assert.rejects(
			() => runMemberMessageCommand(options("follow_up", { format: "json" }), context(), dependencies),
			(error: unknown) => error instanceof UsageError && error.message === "boom",
		);
	}
});

test("member message run: accepted delivery exit 0 with identity, deliveryId, disposition", async () => {
	const outcome = await runMemberMessageCommand(options("follow_up", { format: "json" }), context(), deps());
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "accepted");
	assert.deepEqual(outcome.result.data, {
		member: { name: "Kelly", role: "qa" },
		deliveryId: "delivery-1",
		disposition: "queued",
	});
	assert.equal(render(outcome).exit, 0);
});

test("member message run: disposition passthrough for queued, direct, and steered", async () => {
	const dispositions = [
		{ member: { name: "Kelly", role: "qa" }, deliveryId: "d-1", disposition: "direct" },
		{ member: { name: "Kelly", role: "qa" }, deliveryId: "d-2", disposition: "queued" },
		{ member: { name: "Mary", role: "po" }, deliveryId: "d-3", disposition: "steered" },
	];
	for (const disposition of dispositions) {
		const dependencies = deps({ deliverMessage: async () => ({ ok: true, result: disposition }) });
		const outcome = await runMemberMessageCommand(options("redirect", { format: "json" }), context(), dependencies);
		if (outcome.kind !== "result") throw new Error("expected result");
		assert.equal((outcome.result.data as { disposition: string }).disposition, disposition.disposition);
		assert.equal(render(outcome).exit, 0);
	}
});

test("member message run: stdin content validation happens after read and before delivery", async () => {
	let delivered = false;
	const dependencies = deps({
		readStdin: async () => "",
		deliverMessage: async () => {
			delivered = true;
			return { ok: true, result: QUEUED };
		},
	});
	// Usage errors propagate to the dispatcher renderer (exit 2); delivery never runs.
	await assert.rejects(
		() => runMemberMessageCommand(options("follow_up", { stdin: true }), context(), dependencies),
		/empty content/,
	);
	assert.equal(delivered, false);
});

test("member message run: operational failures exit 1 with stable codes", async () => {
	for (const code of [
		"unknown-session",
		"offline-session",
		"timeout",
		"aborted",
		"transport-error",
		"malformed-response",
		"not-joined",
		"untrusted",
		"unknown-member",
		"ambiguous-member",
		"self-send",
		"invalid-payload",
		"remote-rejected",
		"invalid-ack",
		"outcome-unknown",
	]) {
		const dependencies = deps({ deliverMessage: async () => ({ ok: false, code }) });
		const outcome = await runMemberMessageCommand(
			options("follow_up", { format: "json" }),
			context(),
			dependencies,
		);
		assert.equal(render(outcome).exit, 1, code);
		if (outcome.kind !== "result") continue;
		assert.equal(outcome.result.error?.code, code, code);
	}
});

test("member message run: explicit --session wins over the environment fallback", async () => {
	let seen: { explicitSession?: string; environmentSession?: string } | undefined;
	const dependencies = deps({
		resolveSource: (input) => {
			seen = input;
			return okSource();
		},
		environmentSession: () => "env-1",
	});
	await runMemberMessageCommand(options("follow_up", { session: "s-9" }), context(), dependencies);
	assert.deepEqual(seen, { explicitSession: "s-9", environmentSession: "env-1" });
});

test("member message run: toon and text formats render accepted delivery", async () => {
	const toonOutcome = await runMemberMessageCommand(options("follow_up"), context(), deps());
	assert.match(render(toonOutcome).text, /status: accepted/);

	const textOutcome = await runMemberMessageCommand(options("follow_up", { format: "text" }), context(), deps());
	assert.match(render(textOutcome).text, /Kelly \(qa\)/);
	assert.match(render(textOutcome).text, /queued/);
	assert.match(render(textOutcome).text, /delivery-1/);
});
