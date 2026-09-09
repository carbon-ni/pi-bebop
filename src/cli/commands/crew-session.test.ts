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
	crewSessionAddHelp,
	crewSessionCaptureHelp,
	parseCrewSessionAddCommand,
	parseCrewSessionCaptureCommand,
	parseCrewSessionListCommand,
	parseCrewSessionShowCommand,
	parseCrewSessionResolveCommand,
	crewSessionListHelp,
	crewSessionShowHelp,
	crewSessionResolveHelp,
	runCrewSessionAddCommand,
	runCrewSessionCaptureCommand,
	runCrewSessionListCommand,
	runCrewSessionShowCommand,
	runCrewSessionResolveCommand,
} from "./crew-session.ts";
import type { CliContext } from "../support/context.ts";
import { UsageError } from "../support/arguments.ts";

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
test("crew session parsers accept exact names, IDs, formats, and help", () => {
	assert.deepEqual(parseCrewSessionCaptureCommand(["auth-regression"], "/project"), {
		command: "crew-session-capture",
		name: "auth-regression",
		format: "toon",
		full: false,
	});
	assert.equal(
		parseCrewSessionCaptureCommand(["auth", "--crew", ".pi/bebop/crew.json", "--format=json"], "/project").name,
		"auth",
	);
	assert.equal(
		parseCrewSessionCaptureCommand(["auth", "--crew", ".pi/bebop/crew.json", "--format=json"], "/project").format,
		"json",
	);
	assert.deepEqual(parseCrewSessionCaptureCommand(["auth", "--help"], "/project"), {
		command: "crew-session-capture",
		name: "auth",
		format: "toon",
		full: false,
		help: true,
	});
	assert.equal(
		parseCrewSessionCaptureCommand(["auth", "--crew=.pi/bebop/crew.json", "--format=toon"], "/project").crew,
		".pi/bebop/crew.json",
	);
	assert.equal(
		parseCrewSessionAddCommand(["cs_0123456789abcdef", "Alice", "--format", "text"], "/project").format,
		"text",
	);
	assert.equal(parseCrewSessionAddCommand(["cs_0123456789abcdef", "Alice", "--help"], "/project").help, true);
	assert.deepEqual(
		parseCrewSessionListCommand(["--crew", ".pi/bebop/crew.json", "--limit", "10", "--offset=2"], "/project"),
		{
			command: "crew-session-list",
			crew: ".pi/bebop/crew.json",
			limit: 10,
			offset: 2,
			format: "toon",
			full: false,
		},
	);
	assert.deepEqual(parseCrewSessionShowCommand(["cs_0123456789abcdef", "--format", "json"], "/project"), {
		command: "crew-session-show",
		id: "cs_0123456789abcdef",
		format: "json",
		full: false,
	});
	assert.deepEqual(parseCrewSessionResolveCommand(["cs_0123456789abcdef", "Alice", "--format", "text"], "/project"), {
		command: "crew-session-resolve",
		id: "cs_0123456789abcdef",
		member: "Alice",
		format: "text",
		full: false,
	});
	assert.equal(buildCrewSessionCaptureCommand().name(), "capture");
	assert.equal(buildCrewSessionAddCommand().name(), "add");
	assert.deepEqual(
		buildCrewSessionCaptureCommand().options.map((option) => option.flags),
		["--format <format>", "--crew <locator>"],
	);
	assert.deepEqual(
		buildCrewSessionAddCommand().options.map((option) => option.flags),
		["--format <format>"],
	);
	assert.match(crewSessionCaptureHelp(), /launches Pi/);
	assert.match(crewSessionCaptureHelp(), /--crew <locator>/);
	assert.match(crewSessionAddHelp(), /exact currently joined Member/);
	assert.match(crewSessionListHelp(), /--limit <count>/);
	assert.match(crewSessionShowHelp(), /explicit stored session references/);
	assert.match(crewSessionResolveHelp(), /manual Pi startup specification/);
});

test("crew session resolve handler preserves exact startup fields and help", async () => {
	const outcome = await runCrewSessionResolveCommand(
		{ command: "crew-session-resolve", id: "cs_0123456789abcdef", member: "Alice", format: "json", full: false },
		context("/project"),
		{
			resolve: async () => ({
				ok: true,
				crewSessionId: "cs_0123456789abcdef",
				member: { name: "Alice", role: "developer" },
				startup: {
					argv: ["pi", "--session", "/sessions/alice.jsonl"],
					cwd: "/project",
					sessionId: "pi-session-secret",
					sessionFile: "/sessions/alice.jsonl",
					processState: "unreachable",
					warning: "qualified",
				},
			}),
		},
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") {
		assert.deepEqual(outcome.result.data && (outcome.result.data as { argv: string[] }).argv, [
			"pi",
			"--session",
			"/sessions/alice.jsonl",
		]);
		assert.equal((outcome.result.data as { cwd: string }).cwd, "/project");
	}
	const help = await runCrewSessionResolveCommand(
		{ command: "crew-session-resolve", id: "x", member: "Alice", format: "toon", full: false, help: true },
		context("/project"),
	);
	assert.deepEqual(help, { kind: "help", text: crewSessionResolveHelp() });
});

test("crew session list/show handlers are read-only and return bounded failures", async () => {
	const list = await runCrewSessionListCommand(
		{ command: "crew-session-list", format: "json", full: false, limit: 25, offset: 0 },
		context("/tmp"),
	);
	assert.equal(list.kind, "result");
	if (list.kind === "result") {
		assert.equal(list.result.ok, true);
		assert.equal(list.result.status, "empty");
		assert.deepEqual(list.result.data && (list.result.data as { sessions: unknown[] }).sessions, []);
	}
	const show = await runCrewSessionShowCommand(
		{ command: "crew-session-show", id: "cs_missing", format: "toon", full: false },
		context("/tmp"),
	);
	assert.equal(show.kind, "result");
	if (show.kind === "result") {
		assert.equal(show.result.ok, false);
		assert.equal(show.result.status, "record-not-found");
	}
	const helpList = await runCrewSessionListCommand(
		{ command: "crew-session-list", format: "toon", full: false, limit: 25, offset: 0, help: true },
		context("/tmp"),
	);
	assert.deepEqual(helpList, { kind: "help", text: crewSessionListHelp() });
	const helpShow = await runCrewSessionShowCommand(
		{ command: "crew-session-show", id: "cs_missing", format: "toon", full: false, help: true },
		context("/tmp"),
	);
	assert.deepEqual(helpShow, { kind: "help", text: crewSessionShowHelp() });
});

test("crew session parsers reject duplicate, invalid, missing, and excess arguments", () => {
	assert.throws(() => parseCrewSessionCaptureCommand([], "/project"), UsageError);
	assert.throws(() => parseCrewSessionCaptureCommand(["a", "b"], "/project"), UsageError);
	assert.throws(
		() => parseCrewSessionCaptureCommand(["a", "--help", "--help"], "/project"),
		/Duplicate flag: --help/,
	);
	assert.throws(
		() => parseCrewSessionCaptureCommand(["a", "--format", "toon", "--format", "json"], "/project"),
		/Duplicate flag/,
	);
	assert.throws(
		() => parseCrewSessionCaptureCommand(["a", "--crew", "x", "--crew", "y"], "/project"),
		/Duplicate flag/,
	);
	assert.throws(() => parseCrewSessionCaptureCommand(["a", "--format", "yaml"], "/project"), /Invalid --format/);
	assert.throws(() => parseCrewSessionCaptureCommand(["a", "--format"], "/project"), /Missing value/);
	assert.throws(() => parseCrewSessionCaptureCommand(["a", "--bogus"], "/project"), /unknown option/);
	assert.throws(() => parseCrewSessionAddCommand(["only-id"], "/project"), UsageError);
	assert.throws(
		() => parseCrewSessionAddCommand(["id", "member", "--format", "yaml"], "/project"),
		/Invalid --format/,
	);
	assert.throws(
		() => parseCrewSessionAddCommand(["id", "member", "--format", "toon", "--format", "json"], "/project"),
		/Duplicate flag/,
	);
});

// Handler and trusted-layout resolution contracts.
test("capture handler resolves the canonical manifest and preserves structured success", async () => {
	const root = await project();
	try {
		let request: unknown;
		const outcome = await runCrewSessionCaptureCommand(
			{
				command: "crew-session-capture",
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

test("capture handler handles help, collisions, and operational failures without IO on help", async () => {
	let called = false;
	const help = await runCrewSessionCaptureCommand(
		{ command: "crew-session-capture", name: "x", format: "toon", full: false, help: true },
		context("/missing"),
		dependencies(async () => {
			called = true;
			return success();
		}),
	);
	assert.deepEqual(help, { kind: "help", text: crewSessionCaptureHelp() });
	assert.equal(called, false);
	const root = await project();
	try {
		for (const [outcome, status] of [
			[
				await runCrewSessionCaptureCommand(
					{ command: "crew-session-capture", name: "x", format: "toon", full: false },
					context(root),
					dependencies(async () => failure("name-collision")),
				),
				"name-collision",
			],
			[
				await runCrewSessionCaptureCommand(
					{ command: "crew-session-capture", name: "x", format: "toon", full: false },
					context(root),
					dependencies(async () => failure("capture-empty")),
				),
				"capture-empty",
			],
			[
				await runCrewSessionCaptureCommand(
					{ command: "crew-session-capture", name: "x", format: "toon", full: false },
					context(root),
					dependencies(async () => {
						throw new Error("boom");
					}),
				),
				"operational",
			],
			[
				await runCrewSessionCaptureCommand(
					{ command: "crew-session-capture", name: "x", format: "toon", full: false },
					context(root),
					dependencies(async () => {
						throw "boom";
					}),
				),
				"operational",
			],
		] as const) {
			assert.equal(outcome.kind, "result");
			if (outcome.kind === "result") assert.equal(outcome.result.status, status);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("capture handler rejects an untrusted explicit Locator", async () => {
	const root = await project();
	try {
		const outcome = await runCrewSessionCaptureCommand(
			{ command: "crew-session-capture", name: "x", crew: "/tmp/other/crew.json", format: "toon", full: false },
			context(root),
			dependencies(async () => success()),
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") assert.match(outcome.result.error?.message ?? "", /outside trusted/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("capture handler reports missing and ambiguous trusted layouts", async () => {
	const missing = await runCrewSessionCaptureCommand(
		{ command: "crew-session-capture", name: "x", format: "text", full: false },
		context("/tmp/no-such-bebop-project"),
		dependencies(async () => success()),
	);
	assert.equal(missing.kind, "result");
	if (missing.kind === "result") assert.equal(missing.result.ok, false);
	const root = await project(true);
	try {
		const ambiguous = await runCrewSessionCaptureCommand(
			{ command: "crew-session-capture", name: "x", format: "toon", full: false },
			context(root),
			dependencies(async () => success()),
		);
		assert.equal(ambiguous.kind, "result");
		if (ambiguous.kind === "result") assert.match(ambiguous.result.error?.message ?? "", /both supported/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("add handler uses exact ID/member, supports help, and maps stable failures", async () => {
	const root = await project();
	try {
		let request: unknown;
		const outcome = await runCrewSessionAddCommand(
			{ command: "crew-session-add", id: "cs_0123456789abcdef", member: "Alice", format: "text", full: false },
			context(root),
			dependencies(
				async () => success(),
				async (value) => {
					request = value;
					return success();
				},
			),
		);
		assert.equal(outcome.kind, "result");
		assert.equal((request as { id: string }).id, "cs_0123456789abcdef");
		const noSelector = await runCrewSessionAddCommand(
			{ command: "crew-session-add", id: "cs_0123456789abcdef", member: "Alice", format: "toon", full: false },
			context(root),
			dependencies(
				async () => success(),
				async () => success("cs_0123456789abcdef", null),
			),
		);
		assert.equal(noSelector.kind, "result");
		if (noSelector.kind === "result")
			assert.equal((noSelector.result.data as { crew: string }).crew, "/project/.pi/bebop/crew.json");
		const collision = await runCrewSessionAddCommand(
			{ command: "crew-session-add", id: "cs_0123456789abcdef", member: "Alice", format: "toon", full: false },
			context(root),
			dependencies(
				async () => success(),
				async () => failure("member-already-bound"),
			),
		);
		assert.equal(collision.kind, "result");
		if (collision.kind === "result") assert.equal(collision.result.status, "member-already-bound");
		const help = await runCrewSessionAddCommand(
			{ command: "crew-session-add", id: "id", member: "Alice", format: "toon", full: false, help: true },
			context("/missing"),
			dependencies(async () => success()),
		);
		assert.deepEqual(help, { kind: "help", text: crewSessionAddHelp() });
		const unknownFailure = await runCrewSessionAddCommand(
			{ command: "crew-session-add", id: "id", member: "Alice", format: "toon", full: false },
			context(root),
			dependencies(
				async () => success(),
				async () => {
					throw "busy";
				},
			),
		);
		assert.equal(unknownFailure.kind, "result");
		if (unknownFailure.kind === "result") assert.equal(unknownFailure.result.status, "operational");
		const storeFailure = await runCrewSessionAddCommand(
			{ command: "crew-session-add", id: "id", member: "Alice", format: "toon", full: false },
			context(root),
			dependencies(
				async () => success(),
				async () => {
					throw new CrewSessionStoreError("storage-busy", "busy");
				},
			),
		);
		assert.equal(storeFailure.kind, "result");
		if (storeFailure.kind === "result") assert.equal(storeFailure.result.status, "storage-busy");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
