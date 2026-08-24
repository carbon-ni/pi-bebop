import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	defaultMemberStatusCliDependencies,
	parseMemberStatusCommand,
	runMemberStatusCommand,
	memberStatusHelp,
	type MemberStatusCliDependencies,
} from "./member-status.ts";
import { UsageError } from "../arguments.ts";
import { writeOutcome, type CliOutcome } from "../output.ts";
import type { CliContext } from "../context.ts";
import type { SourceResolution } from "../source-session.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

const ONLINE_STATUS = {
	member: { name: "Kelly", role: "qa" },
	presence: "online",
	activity: "busy",
	hasPendingMessages: true,
	focus: { state: "reported", text: "Reviewing", updatedAt: "2026-08-23T12:00:00.000Z" },
	observedAt: "2026-08-23T12:03:00.000Z",
};

const OFFLINE_STATUS = {
	member: { name: "Dimmy", role: "qa1" },
	presence: "offline",
	activity: "unavailable",
	hasPendingMessages: "unavailable",
	focus: { state: "unavailable" },
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
	const exit = writeOutcome(output, outcome);
	return { exit, text };
}

// --- parse ---

test("member status parse: member positional, format default toon, optional --session", () => {
	const options = parseMemberStatusCommand(["Kelly"]);
	assert.equal(options.command, "member-status");
	assert.equal(options.member, "Kelly");
	assert.equal(options.format, "toon");
	assert.equal(options.session, undefined);

	const withSession = parseMemberStatusCommand(["Kelly", "--session", "s-9"]);
	assert.equal(withSession.session, "s-9");

	const equals = parseMemberStatusCommand(["--session=s-9", "Kelly", "--format", "json"]);
	assert.equal(equals.session, "s-9");
	assert.equal(equals.format, "json");

	const sentinel = parseMemberStatusCommand(["Kelly", "--session", "--", "-x"]);
	assert.equal(sentinel.session, "-x");
});

test("member status parse: trims member and rejects oversized targets", () => {
	assert.throws(() => parseMemberStatusCommand(["  Kelly  "]), /trimmed/);
	const oversized = "k".repeat(257);
	assert.throws(() => parseMemberStatusCommand([oversized]), /at most 256/);
});

test("member status parse: missing member, duplicate flags, unknown flags, bad format", () => {
	assert.throws(() => parseMemberStatusCommand([]), UsageError);
	assert.throws(
		() => parseMemberStatusCommand(["--session", "s-1", "--session", "s-2", "Kelly"]),
		/Duplicate flag: --session/,
	);
	assert.throws(
		() => parseMemberStatusCommand(["Kelly", "--format", "toon", "--format", "json"]),
		/Duplicate flag: --format/,
	);
	assert.throws(() => parseMemberStatusCommand(["Kelly", "--bogus"]), /Unknown flag/);
	assert.throws(() => parseMemberStatusCommand(["Kelly", "--format", "xml"]), /Invalid --format/);
});

test("member status parse: --help short-circuits requirements but validates provided values", () => {
	const options = parseMemberStatusCommand(["--help"]);
	assert.equal(options.help, true);
	assert.equal(options.member, "");
	// Help with provided member still parses.
	assert.equal(parseMemberStatusCommand(["Kelly", "--help"]).member, "Kelly");
	assert.throws(() => parseMemberStatusCommand(["--help", "--format", "xml"]), /Invalid --format/);
});

test("member status default transport maps unavailable endpoints", async () => {
	const result = await defaultMemberStatusCliDependencies.sendStatus(
		{
			ok: true,
			kind: "id",
			idSocketPath: "/tmp/missing-status.sock",
			aliasSocketPath: "/tmp/missing-status.alias",
		},
		"Kelly",
		new AbortController().signal,
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "unknown-session");
});

test("member status default transport covers valid, rejected, and malformed peers", async () => {
	for (const mode of ["valid", "rejected", "malformed"] as const) {
		const dir = await mkdtemp(path.join(tmpdir(), "bebop-status-cli-"));
		const socketPath = path.join(dir, "member.sock");
		const server = net.createServer((socket) => {
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				const request = JSON.parse(String(chunk)) as { id: string | number };
				const wire =
					mode === "valid"
						? { jsonrpc: "2.0", id: request.id, result: { status: ONLINE_STATUS } }
						: mode === "rejected"
							? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "not-joined" } }
							: { jsonrpc: "2.0", id: request.id, result: {} };
				socket.write(JSON.stringify(wire) + "\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			const outcome = await defaultMemberStatusCliDependencies.sendStatus(
				{ ok: true, kind: "id", idSocketPath: socketPath, aliasSocketPath: socketPath },
				"Kelly",
				new AbortController().signal,
			);
			assert.equal(outcome.ok, mode === "valid");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("member status default transport reports unknown when both id and alias are stale", async () => {
	const result = await defaultMemberStatusCliDependencies.sendStatus(
		{
			ok: true,
			kind: "id",
			idSocketPath: "/tmp/missing-status-id.sock",
			aliasSocketPath: "/tmp/missing-status-alias.sock",
		},
		"Kelly",
		new AbortController().signal,
	);
	assert.deepEqual(result, { ok: false, code: "unknown-session" });
});

test("member status default transport falls back from stale id to alias", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-status-alias-"));
	const aliasPath = path.join(dir, "alias.sock");
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			const request = JSON.parse(String(chunk)) as { id: string | number };
			socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { status: ONLINE_STATUS } }) + "\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(aliasPath, resolve));
	try {
		const result = await defaultMemberStatusCliDependencies.sendStatus(
			{ ok: true, kind: "id", idSocketPath: path.join(dir, "missing.sock"), aliasSocketPath: aliasPath },
			"Kelly",
			new AbortController().signal,
		);
		assert.equal(result.ok, true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});

// --- run: source selection ---

test("member status run: session-required is usage-class exit 2 with stable code", async () => {
	const dependencies = deps({ resolveSource: () => ({ ok: false, code: "session-required", message: "no source" }) });
	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "Kelly", format: "json" },
		context(),
		dependencies,
	);
	const { exit, text } = render(outcome);
	assert.equal(exit, 2);
	assert.match(text, /session-required/);
});

test("member status run: invalid-session is usage-class exit 2 with stable code", async () => {
	const dependencies = deps({ resolveSource: () => ({ ok: false, code: "invalid-session", message: "bad" }) });
	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "Kelly", format: "json" },
		context(),
		dependencies,
	);
	assert.equal(render(outcome).exit, 2);
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
	assert.match(render(textOutcome).text, /Reviewing/);
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

test("member status run: --help returns deterministic help text", async () => {
	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "", format: "toon", help: true },
		context(),
		deps(),
	);
	assert.equal(outcome.kind, "help");
	if (outcome.kind !== "help") return;
	assert.equal(outcome.text, memberStatusHelp());
	assert.equal(render(outcome).exit, 0);
});
