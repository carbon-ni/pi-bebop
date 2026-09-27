import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
	buildMemberStatusCommand,
	defaultMemberStatusCliDependencies,
	readMemberStatusCommand,
	runMemberStatusCommand,
	statusThroughSdk,
	type MemberStatusCliDependencies,
} from "./member-status.ts";
import { Command } from "commander";
import { UsageError } from "../support/arguments.ts";
import { writeOutcome, type CliOutcome } from "../support/output.ts";
import type { CliContext } from "../support/context.ts";
import type { SourceResolution } from "../support/source-session.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

const ONLINE_STATUS = {
	member: { name: "Kelly", role: "qa" },
	presence: "online",
	activity: "busy",
	hasPendingMessages: true,
	observedAt: "2026-08-23T12:03:00.000Z",
};

const OFFLINE_STATUS = {
	member: { name: "Dimmy", role: "qa1" },
	presence: "offline",
	activity: "unavailable",
	hasPendingMessages: "unavailable",
	observedAt: "2026-08-23T12:03:00.000Z",
};

function okSource(): SourceResolution & { ok: true } {
	return { ok: true, kind: "id", idSocketPath: "/bebop/s-1.sock", aliasSocketPath: "/bebop/s-1.alias" };
}

function deps(overrides: Partial<MemberStatusCliDependencies> = {}): MemberStatusCliDependencies {
	return {
		resolveSource: () => okSource(),
		sendStatus: async () => ({ ok: true, status: ONLINE_STATUS as never }),
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

// --- parse ---

function parseInto(tokens: readonly string[]) {
	const command = buildMemberStatusCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return readMemberStatusCommand(command);
}

test("member status reader validates target and format", () => {
	assert.equal(parseInto(["Kelly", "--format", "text"]).format, "text");
	for (const tokens of [["--format", "yaml", "Kelly"], [" Kelly"], [], ["Kelly", "--format", "json"]] as const) {
		if (tokens.length === 2) assert.equal(parseInto(tokens).format, "json");
		else if (tokens[0] !== "Kelly") assert.throws(() => parseInto(tokens), UsageError);
	}
	assert.throws(() => parseInto(["x".repeat(257)]), /at most 256/);
});

// --- run: source selection ---

test("member status run: session-required is a usage-class failure", async () => {
	const dependencies = deps({ resolveSource: () => ({ ok: false, code: "session-required", message: "no source" }) });
	await assert.rejects(
		() =>
			runMemberStatusCommand(
				{ command: "member-status", member: "Kelly", format: "json" },
				context(),
				dependencies,
			),
		(error: unknown) => error instanceof UsageError && error.message === "no source",
	);
});

test("member status run: invalid-session is a usage-class failure", async () => {
	const dependencies = deps({ resolveSource: () => ({ ok: false, code: "invalid-session", message: "bad" }) });
	await assert.rejects(
		() =>
			runMemberStatusCommand(
				{ command: "member-status", member: "Kelly", format: "json" },
				context(),
				dependencies,
			),
		UsageError,
	);
});

test("member status run: environment fallback feeds resolution when --session absent", async () => {
	let seen: { explicitSession?: string; environmentSession?: string } | undefined;
	const dependencies = deps({
		resolveSource: (input) => {
			seen = input;
			return okSource();
		},
		environmentSession: () => "env-1",
	});
	await runMemberStatusCommand(
		{ command: "member-status", member: "Kelly", format: "toon" },
		context(),
		dependencies,
	);
	assert.deepEqual(seen, { explicitSession: undefined, environmentSession: "env-1" });
});

test("member status run: explicit --session wins and skips the environment", async () => {
	let seen: { explicitSession?: string; environmentSession?: string } | undefined;
	const dependencies = deps({
		resolveSource: (input) => {
			seen = input;
			return okSource();
		},
		environmentSession: () => "env-1",
	});
	await runMemberStatusCommand(
		{ command: "member-status", member: "Kelly", format: "toon", session: "s-9" },
		context(),
		dependencies,
	);
	assert.deepEqual(seen, { explicitSession: "s-9", environmentSession: "env-1" });
});

// --- run: status outcomes ---

test("member status run: online status is observed, exit 0, status passthrough untouched", async () => {
	const dependencies = deps();
	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "Kelly", format: "json" },
		context(),
		dependencies,
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "observed");
	assert.equal(outcome.result.target, "Kelly");
	assert.deepEqual(outcome.result.data, { status: ONLINE_STATUS });
	assert.equal(render(outcome).exit, 0);
});

test("member status run: offline presence is a successful observed result, exit 0", async () => {
	const dependencies = deps({ sendStatus: async () => ({ ok: true, status: OFFLINE_STATUS as never }) });
	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "Dimmy", format: "json" },
		context(),
		dependencies,
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "observed");
	assert.equal((outcome.result.data as { status: { presence: string } }).status.presence, "offline");
});

test("member status run: toon and text formats render observed state", async () => {
	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "Kelly", format: "toon" },
		context(),
		deps(),
	);
	assert.match(render(outcome).text, /status: observed/);

	const textOutcome = await runMemberStatusCommand(
		{ command: "member-status", member: "Kelly", format: "text" },
		context(),
		deps(),
	);
	assert.match(render(textOutcome).text, /Kelly/);
	assert.match(render(textOutcome).text, /pending messages/);
});

test("member status SDK boundary maps unexpected adapter failures without leaking details", async () => {
	const outcome = await statusThroughSdk("safe-session", "Kelly", new AbortController().signal, {
		listSources: async () => [],
		selectSource: async () => {
			throw new Error("internal socket detail");
		},
	});
	assert.deepEqual(outcome, { ok: false, code: "transport-error" });
});

test("member status SDK boundary maps pre-aborted SIGINT before source selection", async () => {
	const outcome = await defaultMemberStatusCliDependencies.sendStatus(
		okSource(),
		"Kelly",
		AbortSignal.abort(),
		"safe-session",
	);
	assert.deepEqual(outcome, { ok: false, code: "aborted" });
});

test("member status run forwards SIGINT cancellation to the SDK boundary", async () => {
	const controller = new AbortController();
	controller.abort();
	let observedSignal: AbortSignal | undefined;
	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "Kelly", format: "json" },
		{ ...context(), signal: controller.signal },
		deps({
			sendStatus: async (_source, _target, signal) => {
				observedSignal = signal;
				return { ok: false, code: "aborted" };
			},
		}),
	);
	assert.equal(observedSignal?.aborted, true);
	assert.equal(render(outcome).exit, 1);
});

test("member status run: operational failures exit 1 with stable codes", async () => {
	for (const code of [
		"unknown-session",
		"offline-session",
		"timeout",
		"aborted",
		"transport-error",
		"malformed-response",
		"not-joined",
		"unknown-member",
		"ambiguous-member",
		"self-query",
	]) {
		const dependencies = deps({ sendStatus: async () => ({ ok: false, code }) });
		const outcome = await runMemberStatusCommand(
			{ command: "member-status", member: "Kelly", format: "json" },
			context(),
			dependencies,
		);
		assert.equal(render(outcome).exit, 1, code);
		if (outcome.kind !== "result") continue;
		assert.equal(outcome.result.error?.code, code, code);
		assert.equal(outcome.result.status, "error", code);
	}
});
