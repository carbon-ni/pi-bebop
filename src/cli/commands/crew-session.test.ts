import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { CrewSessionStoreError } from "../../infra/crew-session-store.ts";
import type { CrewSessionCaptureOutcome, CrewSessionCliDependencies } from "./crew-session.ts";
import {
	buildCrewSessionAddCommand,
	buildCrewSessionCaptureCommand,
	buildCrewSessionListCommand,
	buildCrewSessionResolveCommand,
	buildCrewSessionShowCommand,
	readCrewSessionAddCommand,
	readCrewSessionCaptureCommand,
	readCrewSessionListCommand,
	readCrewSessionResolveCommand,
	readCrewSessionShowCommand,
	runCrewSessionAddCommand,
	runCrewSessionCaptureCommand,
	runCrewSessionListCommand,
	runCrewSessionShowCommand,
	runCrewSessionResolveCommand,
} from "./crew-session.ts";
import type { CliContext } from "../support/context.ts";
import { UsageError } from "../support/arguments.ts";

function parseInto(build: () => import("commander").Command, tokens: readonly string[]) {
	const command = build()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return command;
}

function context(cwd: string): CliContext {
	return { cwd, input: new PassThrough(), signal: new AbortController().signal };
}

function success(id = "cs_0123456789abcdef", selector: string | null = "alpha"): CrewSessionCaptureOutcome {
	return {
		ok: true,
		capturedCount: 1,
		missing: [{ name: "Bob", reason: "offline" }],
		record: {
			schemaVersion: 1,
			id,
			name: "auth regression",
			crew: {
				...(selector === null ? {} : { selector }),
				locator: "/project/.pi/bebop/crew.json",
				manifestFingerprint: "mfv1-sha256-test",
			},
			createdAt: "2026-09-09T12:00:00.000Z",
			state: "partial",
			members: [
				{
					name: "Alice",
					role: "developer",
					status: "captured",
					piSessionId: "session-alice",
					persistedSessionFile: "/sessions/alice.jsonl",
					sessionCwd: "/project",
					sessionRoot: "/sessions",
					capturedAt: "2026-09-09T12:00:00.000Z",
				},
				{ name: "Bob", role: "qa", status: "missing", reason: "offline" },
			],
		},
	};
}

function failure(code: "capture-empty" | "name-collision" | "member-already-bound"): CrewSessionCaptureOutcome {
	return {
		ok: false,
		code,
		message: "capture failed",
		...(code === "name-collision" ? { candidateIds: ["cs_0123456789abcdef"] } : {}),
	};
}

function dependencies(
	capture: CrewSessionCliDependencies["capture"],
	add: CrewSessionCliDependencies["add"] = async () => success(),
): CrewSessionCliDependencies {
	return { capture, add };
}

async function project(withBoth = false): Promise<string> {
	const root = await mkdtemp(path.join("/tmp", "bebop-cli-session-"));
	const config = path.join(root, ".pi", "bebop");
	await mkdir(config, { recursive: true });
	await writeFile(path.join(config, "crew.json"), "{}\n");
	if (withBoth) {
		await mkdir(path.join(root, ".pi", "crew"), { recursive: true });
		await writeFile(path.join(root, ".pi", "crew", "crew.json"), "{}\n");
	}
	return root;
}

// Parser and help contracts.
test("crew session readers preserve canonical arguments and reject semantic values", () => {
	const capture = readCrewSessionCaptureCommand(
		parseInto(buildCrewSessionCaptureCommand, ["review", "--crew", ".pi/bebop/crew.json"]),
	);
	assert.equal(capture.name, "review");
	assert.equal(capture.crew, ".pi/bebop/crew.json");
	assert.equal(readCrewSessionAddCommand(parseInto(buildCrewSessionAddCommand, ["cs_1", "Alice"])).member, "Alice");
	assert.equal(
		readCrewSessionListCommand(
			parseInto(buildCrewSessionListCommand, ["--crew", ".pi/bebop/crew.json", "--limit", "2", "--offset", "1"]),
		).limit,
		2,
	);
	assert.equal(readCrewSessionShowCommand(parseInto(buildCrewSessionShowCommand, ["cs_1"])).id, "cs_1");
	assert.equal(
		readCrewSessionResolveCommand(parseInto(buildCrewSessionResolveCommand, ["cs_1", "Alice"])).member,
		"Alice",
	);
	assert.throws(() => readCrewSessionCaptureCommand(parseInto(buildCrewSessionCaptureCommand, ["   "])), UsageError);
	assert.throws(
		() => readCrewSessionListCommand(parseInto(buildCrewSessionListCommand, ["--limit", "x"])),
		UsageError,
	);
	assert.throws(
		() => readCrewSessionListCommand(parseInto(buildCrewSessionListCommand, ["--offset", "-1"])),
		UsageError,
	);
});

// Handler and trusted-layout resolution contracts.
test("capture handler resolves the canonical manifest and preserves structured success", async () => {
	const root = await project();
	try {
		let request: unknown;
		const outcome = await runCrewSessionCaptureCommand(
			{
				command: "session-capture",
				name: "auth regression",
				crew: ".pi/bebop/crew.json",
				format: "json",
				full: true,
			},
			context(root),
			dependencies(async (value) => {
				request = value;
				return success();
			}),
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, true);
		assert.equal(outcome.result.status, "partial");
		assert.equal(outcome.result.target, "cs_0123456789abcdef");
		assert.deepEqual(outcome.result.data, {
			crewSessionId: "cs_0123456789abcdef",
			name: "auth regression",
			crew: "alpha",
			state: "partial",
			capturedCount: 1,
			expectedCount: 2,
			missing: [{ name: "Bob", reason: "offline" }],
		});
		assert.equal((request as { manifestPath: string }).manifestPath, path.join(root, ".pi/bebop/crew.json"));
		assert.equal(outcome.format, "json");
		assert.equal(outcome.full, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("capture handler rejects an untrusted explicit Locator", async () => {
	const root = await project();
	try {
		const outcome = await runCrewSessionCaptureCommand(
			{ command: "session-capture", name: "x", crew: "/tmp/other/crew.json", format: "toon", full: false },
			context(root),
			dependencies(async () => success()),
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") assert.match(outcome.result.error?.message ?? "", /outside trusted/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("capture handler maps outcome failures and store failures without losing the target", async () => {
	const root = await project();
	try {
		const options = {
			command: "session-capture" as const,
			name: "x",
			crew: ".pi/bebop/crew.json",
			format: "toon" as const,
			full: false,
		};
		const collision = await runCrewSessionCaptureCommand(options, context(root), {
			capture: async () => failure("name-collision"),
			add: async () => success(),
		});
		assert.equal(collision.kind, "result");
		if (collision.kind === "result") assert.match(collision.result.error?.message ?? "", /cs_0123456789abcdef/);
		const empty = await runCrewSessionCaptureCommand(options, context(root), {
			capture: async () => failure("capture-empty"),
			add: async () => success(),
		});
		assert.equal(empty.kind, "result");
		if (empty.kind === "result") assert.equal(empty.result.status, "capture-empty");
		const stored = await runCrewSessionCaptureCommand(options, context(root), {
			capture: async () => {
				throw new CrewSessionStoreError("storage-failed", "disk unavailable");
			},
			add: async () => success(),
		});
		assert.equal(stored.kind, "result");
		if (stored.kind === "result") assert.equal(stored.result.error?.code, "storage-failed");
		const unknown = await runCrewSessionCaptureCommand(options, context(root), {
			capture: async () => {
				throw "unexpected capture failure";
			},
			add: async () => success(),
		});
		assert.equal(unknown.kind, "result");
		if (unknown.kind === "result") assert.equal(unknown.result.error?.message, "Crew Session capture failed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("crew session list, show, resolve, and add expose stable empty and failure results", async () => {
	const listed = await runCrewSessionListCommand(
		{ command: "session-list", limit: 25, offset: 0, format: "toon", full: false },
		context("/tmp/no-such-bebop-project"),
	);
	assert.equal(listed.kind, "result");
	if (listed.kind === "result") {
		assert.equal(listed.result.status, "empty");
		assert.equal((listed.result.data as { next: string }).next, "pi-bebop session capture <name>");
	}
	const shown = await runCrewSessionShowCommand(
		{ command: "session-show", id: "missing", format: "toon", full: false },
		context("/tmp/no-such-bebop-project"),
	);
	assert.equal(shown.kind, "result");
	if (shown.kind === "result") assert.equal(shown.result.error?.code, "record-not-found");
	const resolved = await runCrewSessionResolveCommand(
		{ command: "session-resolve", id: "missing", member: "Alice", format: "toon", full: false },
		context("/tmp/no-such-bebop-project"),
	);
	assert.equal(resolved.kind, "result");
	if (resolved.kind === "result") assert.equal(resolved.result.error?.code, "record-not-found");
	const added = await runCrewSessionAddCommand(
		{ command: "session-add", id: "missing", member: "Alice", format: "toon", full: false },
		context("/tmp/no-such-bebop-project"),
		{ capture: async () => success(), add: async () => success() },
	);
	assert.equal(added.kind, "result");
	if (added.kind === "result") assert.equal(added.result.error?.code, "operational");
	const root = await project();
	try {
		const addedSuccess = await runCrewSessionAddCommand(
			{ command: "session-add", id: "cs_1", member: "Alice", format: "json", full: true },
			context(root),
			{ capture: async () => success(), add: async () => success("cs_1", null) },
		);
		assert.equal(addedSuccess.kind, "result");
		if (addedSuccess.kind === "result") {
			assert.equal(addedSuccess.result.ok, true);
			assert.equal(addedSuccess.format, "json");
			assert.equal(addedSuccess.full, true);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("session handlers preserve successful resolution and report deterministic operational failures", async () => {
	const resolved = await runCrewSessionResolveCommand(
		{ command: "session-resolve", id: "cs_1", member: "Alice", format: "json", full: true },
		context("/project"),
		{
			resolve: async () => ({
				ok: true,
				crewSessionId: "cs_1",
				member: { name: "Alice", role: "developer" },
				startup: {
					argv: ["pi", "--session", "/sessions/alice.jsonl"],
					cwd: "/project",
					sessionId: "session-alice",
					sessionFile: "/sessions/alice.jsonl",
					processState: "unreachable",
					warning: "start manually",
				},
			}),
		},
	);
	assert.equal(resolved.kind, "result");
	if (resolved.kind === "result") {
		assert.equal(resolved.result.status, "resolved");
		assert.deepEqual(resolved.result.data, {
			crewSessionId: "cs_1",
			member: { name: "Alice", role: "developer" },
			argv: ["pi", "--session", "/sessions/alice.jsonl"],
			cwd: "/project",
			sessionId: "session-alice",
			sessionFile: "/sessions/alice.jsonl",
			processState: "unreachable",
			warning: "start manually",
		});
	}
	const failed = await runCrewSessionResolveCommand(
		{ command: "session-resolve", id: "cs_1", member: "Nobody", format: "toon", full: false },
		context("/project"),
		{
			resolve: async () => ({
				ok: false,
				code: "member-not-captured",
				message: "not captured",
				recovery: "capture it",
			}),
		},
	);
	assert.equal(failed.kind, "result");
	if (failed.kind === "result") assert.equal(failed.result.error?.code, "member-not-captured");
	const thrown = await runCrewSessionResolveCommand(
		{ command: "session-resolve", id: "cs_1", member: "Nobody", format: "toon", full: false },
		context("/project"),
		{
			resolve: async () => {
				throw "unexpected resolution failure";
			},
		},
	);
	assert.equal(thrown.kind, "result");
	if (thrown.kind === "result") assert.equal(thrown.result.error?.message, "Crew Session resolution failed");

	const listed = await runCrewSessionListCommand(
		{ command: "session-list", crew: "/tmp/outside/crew.json", limit: 25, offset: 0, format: "toon", full: false },
		context("/project"),
	);
	assert.equal(listed.kind, "result");
	if (listed.kind === "result") assert.equal(listed.result.error?.code, "operational");
});

test("capture handler reports missing and ambiguous trusted layouts", async () => {
	const missing = await runCrewSessionCaptureCommand(
		{ command: "session-capture", name: "x", format: "text", full: false },
		context("/tmp/no-such-bebop-project"),
		dependencies(async () => success()),
	);
	assert.equal(missing.kind, "result");
	if (missing.kind === "result") assert.equal(missing.result.ok, false);
	const root = await project(true);
	try {
		const ambiguous = await runCrewSessionCaptureCommand(
			{ command: "session-capture", name: "x", format: "toon", full: false },
			context(root),
			dependencies(async () => success()),
		);
		assert.equal(ambiguous.kind, "result");
		if (ambiguous.kind === "result") assert.match(ambiguous.result.error?.message ?? "", /both supported/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
