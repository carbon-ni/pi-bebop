import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
	parseMemberMessageCommand,
	runMemberMessageCommand,
	memberMessageHelp,
	type MemberMessageCliDependencies,
	type MemberMessageIntent,
} from "./member-message.ts";
import { UsageError } from "../arguments.ts";
import { writeOutcome, type CliOutcome } from "../output.ts";
import type { CliContext } from "../context.ts";
import type { SourceResolution } from "../source-session.ts";

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
	const exit = writeOutcome(output, outcome);
	return { exit, text };
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

test("member follow-up parse: member, message, session, instructions, format", () => {
	const parsed = parseMemberMessageCommand(
		["Kelly", "--message", "wrap up", "--instruction", "a", "--instruction", "b"],
		"follow_up",
	);
	assert.equal(parsed.command, "member-follow-up");
	assert.equal(parsed.member, "Kelly");
	assert.equal(parsed.message, "wrap up");
	assert.deepEqual(parsed.instructions, ["a", "b"]);
	assert.equal(parsed.stdin, false);
	assert.equal(parsed.format, "toon");

	const withSession = parseMemberMessageCommand(["--session", "s-9", "Kelly", "--message", "x"], "redirect");
	assert.equal(withSession.session, "s-9");
	assert.equal(withSession.command, "member-redirect");
});

test("member message parse: --stdin and sentinel values", () => {
	const stdin = parseMemberMessageCommand(["Kelly", "--stdin"], "follow_up");
	assert.equal(stdin.stdin, true);
	const sentinel = parseMemberMessageCommand(["Kelly", "--message", "--", "-x"], "follow_up");
	assert.equal(sentinel.message, "-x");
	const equals = parseMemberMessageCommand(["Kelly", "--session=s-7", "--message=y"], "redirect");
	assert.equal(equals.session, "s-7");
	assert.equal(equals.message, "y");
});

test("member message parse: exactly one message source, non-empty, NUL-free, bounded", () => {
	assert.throws(() => parseMemberMessageCommand(["Kelly"], "follow_up"), /Missing message source/);
	assert.throws(
		() => parseMemberMessageCommand(["Kelly", "--message", "x", "--stdin"], "follow_up"),
		/Choose exactly one message source/,
	);
	assert.throws(
		() => parseMemberMessageCommand(["Kelly", "--message", "  "], "follow_up"),
		/--message must not be empty/,
	);
	assert.throws(() => parseMemberMessageCommand(["Kelly", "--message", "a\0b"], "follow_up"), /NUL/);
	assert.throws(
		() => parseMemberMessageCommand(["Kelly", "--message", "x".repeat(1_000_001)], "follow_up"),
		/message limit/,
	);
});

test("member message parse: instruction limits, trimming, NUL, order preserved", () => {
	assert.throws(
		() => parseMemberMessageCommand(["Kelly", "--message", "x", "--instruction", " "], "follow_up"),
		/trimmed/,
	);
	assert.throws(
		() => parseMemberMessageCommand(["Kelly", "--message", "x", "--instruction", "a\0b"], "follow_up"),
		/NUL/,
	);
	assert.throws(
		() =>
			parseMemberMessageCommand(
				[
					"Kelly",
					"--message",
					"x",
					...Array.from({ length: 33 }, (_, index) => ["--instruction", `i${index}`]).flat(),
				],
				"follow_up",
			),
		/maximum is 32/,
	);
});

test("member message parse: no wait flag is accepted; unknown-flag recovery names accepted-only", () => {
	assert.throws(
		() => parseMemberMessageCommand(["Kelly", "--message", "x", "--wait", "response"], "follow_up"),
		/accepted-delivery only/,
	);
	assert.throws(
		() => parseMemberMessageCommand(["Kelly", "--message", "x", "--wait_for", "accepted"], "redirect"),
		/accepted-delivery only/,
	);
	assert.throws(() => parseMemberMessageCommand(["Kelly", "--message", "x", "--bogus"], "follow_up"), /Unknown flag/);
});

test("member message parse: duplicate flags, missing member, bad format, trimmed target", () => {
	assert.throws(
		() => parseMemberMessageCommand(["Kelly", "--message", "x", "--message", "y"], "follow_up"),
		/Duplicate flag: --message/,
	);
	assert.throws(() => parseMemberMessageCommand(["--message", "x"], "follow_up"), /Missing <member>/);
	assert.throws(
		() => parseMemberMessageCommand(["Kelly", "--message", "x", "--format", "xml"], "follow_up"),
		/Invalid --format/,
	);
	assert.throws(() => parseMemberMessageCommand(["  Kelly  ", "--message", "x"], "follow_up"), /trimmed/);
});

test("member message parse: --help short-circuits requirements but validates provided values", () => {
	assert.equal(parseMemberMessageCommand(["--help"], "follow_up").help, true);
	assert.equal(parseMemberMessageCommand(["Kelly", "--help"], "redirect").member, "Kelly");
	assert.throws(() => parseMemberMessageCommand(["--help", "--format", "xml"], "follow_up"), /Invalid --format/);
});

// --- run: source selection + delivery outcomes ---

test("member message run: session-required and invalid-session are usage-class exit 2", async () => {
	for (const code of ["session-required", "invalid-session"] as const) {
		const dependencies = deps({ resolveSource: () => ({ ok: false, code, message: "boom" }) });
		const outcome = await runMemberMessageCommand(
			options("follow_up", { format: "json" }),
			context(),
			dependencies,
		);
		assert.equal(render(outcome).exit, 2, code);
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

test("member message run: --help returns deterministic help text naming accepted-only", async () => {
	for (const intent of ["follow_up", "redirect"] as const) {
		const outcome = await runMemberMessageCommand(options(intent, { help: true }), context(), deps());
		assert.equal(outcome.kind, "help");
		if (outcome.kind !== "help") return;
		assert.equal(outcome.text, memberMessageHelp(intent));
		assert.match(outcome.text, /NEVER means replied/);
		assert.match(outcome.text, /no wait_for flag/);
		assert.equal(render(outcome).exit, 0);
	}
});
