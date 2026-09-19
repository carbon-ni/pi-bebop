import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { CliContext } from "../support/context.ts";
import { runCrewSessionCaptureCommand } from "./crew-session.ts";

function context(cwd: string): CliContext {
	return { cwd, input: process.stdin, output: process.stdout, signal: new AbortController().signal, environment: {} };
}

const captureOptions = { command: "session-capture" as const, name: "review", format: "json" as const, full: false };
const deps = {
	capture: async () => ({ ok: true as const, record: {} as never, capturedCount: 0, missing: [] }),
	add: async () => ({ ok: true as const, record: {} as never, capturedCount: 0, missing: [] }),
};

test("crew session manifest resolution fails closed on missing and ambiguous layouts", async () => {
	// No manifest in an empty project -> operational failure.
	const empty = await mkdtemp(path.join(tmpdir(), "bebop-session-empty-"));
	try {
		const missing = await runCrewSessionCaptureCommand(captureOptions, context(empty), deps);
		assert.equal(missing.kind, "result");
		if (missing.kind === "result")
			assert.equal(missing.result.error?.message, "no supported Crew manifest found in the current project");
	} finally {
		await rm(empty, { recursive: true, force: true });
	}

	// Both supported layouts present -> ambiguous failure.
	const both = await mkdtemp(path.join(tmpdir(), "bebop-session-both-"));
	try {
		await mkdir(path.join(both, ".pi/bebop/sockets"), { recursive: true });
		await mkdir(path.join(both, ".pi/crew/sockets"), { recursive: true });
		const scaffold = { version: 1, members: [] };
		await writeFile(path.join(both, ".pi/bebop/crew.json"), JSON.stringify(scaffold));
		await writeFile(path.join(both, ".pi/crew/crew.json"), JSON.stringify(scaffold));
		const ambiguous = await runCrewSessionCaptureCommand(captureOptions, context(both), deps);
		assert.equal(ambiguous.kind, "result");
		if (ambiguous.kind === "result")
			assert.equal(
				ambiguous.result.error?.message,
				"both supported Crew manifests exist; pass one exact --crew Locator",
			);
	} finally {
		await rm(both, { recursive: true, force: true });
	}

	// A requested locator outside the trusted project layout is rejected.
	const project = await mkdtemp(path.join(tmpdir(), "bebop-session-project-"));
	try {
		await mkdir(path.join(project, ".pi/bebop"), { recursive: true });
		await writeFile(path.join(project, ".pi/bebop/crew.json"), "{}");
		const untrusted = await runCrewSessionCaptureCommand(
			{ ...captureOptions, crew: "/tmp/foreign-crew.json" },
			context(project),
			deps,
		);
		assert.equal(untrusted.kind, "result");
		if (untrusted.kind === "result")
			assert.equal(untrusted.result.error?.message, "Crew Locator is outside trusted project layout");
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});
