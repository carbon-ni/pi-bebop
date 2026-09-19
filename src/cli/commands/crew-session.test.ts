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
