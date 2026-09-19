import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { CliContext } from "../support/context.ts";
import {
	runCrewSessionAddCommand,
	runCrewSessionCaptureCommand,
	runCrewSessionListCommand,
	runCrewSessionResolveCommand,
	runCrewSessionShowCommand,
} from "./crew-session.ts";

function context(cwd = "/project"): CliContext {
	return {
		cwd,
		input: process.stdin,
		output: process.stdout,
		signal: new AbortController().signal,
		environment: {},
	};
}

const captureOptions = { command: "session-capture" as const, name: "review", format: "json" as const, full: false };
const addOptions = {
	command: "session-add" as const,
	id: "cs_0123456789abcdef",
	member: "Alice",
	format: "json" as const,
	full: false,
};

test("Crew Session command adapters preserve empty, invalid, and operational outcomes", async () => {
	const emptyList = await runCrewSessionListCommand(
		{ command: "session-list", limit: 25, offset: 0, format: "toon", full: false },
		context(),
	);
	assert.equal(emptyList.kind, "result");
	if (emptyList.kind === "result") assert.equal(emptyList.result.ok, true);

	const missingShow = await runCrewSessionShowCommand(
		{ command: "session-show", id: "cs_missing", format: "toon", full: false },
		context(),
	);
	assert.equal(missingShow.kind, "result");
	if (missingShow.kind === "result") assert.equal(missingShow.result.status, "record-not-found");

	const resolveFailure = await runCrewSessionResolveCommand(
		{ command: "session-resolve", id: "cs_missing", member: "Alice", format: "toon", full: false },
		context(),
		{ resolve: async () => ({ ok: false, code: "record-not-found", message: "missing", recovery: "capture" }) },
	);
	assert.equal(resolveFailure.kind, "result");
	if (resolveFailure.kind === "result") assert.equal(resolveFailure.result.error?.code, "record-not-found");

	const resolveSuccess = await runCrewSessionResolveCommand(
		{ command: "session-resolve", id: "cs_ok", member: "Alice", format: "json", full: true },
		context(),
		{
			resolve: async () => ({
				ok: true,
				crewSessionId: "cs_ok",
				member: { name: "Alice", role: "developer" },
				startup: {
					argv: ["pi", "--session", "/sessions/alice.jsonl"] as const,
					cwd: "/project",
					sessionId: "pi-session",
					sessionFile: "/sessions/alice.jsonl",
					processState: "unreachable" as const,
					warning: "not a lock",
				},
			}),
		},
	);
	assert.equal(resolveSuccess.kind, "result");
	if (resolveSuccess.kind === "result") assert.equal(resolveSuccess.result.status, "resolved");
});

test("Crew Session capture and add adapters reject untrusted locators before mutation", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "bebop-crew-session-command-"));
	try {
		await mkdir(path.join(root, ".pi", "bebop"), { recursive: true });
		await writeFile(path.join(root, ".pi", "bebop", "crew.json"), "{}");
		let captureCalls = 0;
		const capture = await runCrewSessionCaptureCommand(
			{ ...captureOptions, crew: "/tmp/foreign-crew.json" },
			context(root),
			{
				capture: async () => {
					captureCalls += 1;
					return { ok: false, code: "capture-empty", message: "empty" };
				},
				add: async () => ({ ok: false, code: "capture-empty", message: "empty" }),
			},
		);
		assert.equal(captureCalls, 0);
		assert.equal(capture.kind, "result");
		if (capture.kind === "result") assert.equal(capture.result.status, "operational");

		const successfulOutcome = {
			ok: true as const,
			record: {
				id: "cs_0123456789abcdef",
				name: "review",
				state: "partial" as const,
				crew: { selector: "alpha", locator: ".pi/bebop/crew.json" },
				members: [{ name: "Alice" }],
			},
			capturedCount: 1,
			missing: [],
		};
		const successfulCapture = await runCrewSessionCaptureCommand(
			{ ...captureOptions, crew: ".pi/bebop/crew.json" },
			context(root),
			{ capture: async () => successfulOutcome, add: async () => successfulOutcome },
		);
		assert.equal(successfulCapture.kind, "result");
		if (successfulCapture.kind === "result") assert.equal(successfulCapture.result.status, "partial");

		const captured = await runCrewSessionCaptureCommand(
			{ ...captureOptions, crew: ".pi/bebop/crew.json" },
			context(root),
			{
				capture: async () => ({
					ok: false,
					code: "capture-ambiguous",
					message: "ambiguous",
					candidateIds: ["one", "two"],
				}),
				add: async () => ({ ok: false, code: "capture-empty", message: "empty" }),
			},
		);
		assert.equal(captured.kind, "result");
		if (captured.kind === "result") assert.match(captured.result.error?.message ?? "", /one, two/);

		const add = await runCrewSessionAddCommand(addOptions, context(root), {
			capture: async () => ({ ok: false, code: "capture-empty", message: "empty" }),
			add: async () => ({ ok: false, code: "capture-empty", message: "empty" }),
		});
		assert.equal(add.kind, "result");
		if (add.kind === "result") assert.equal(add.result.status, "capture-empty");
		const successfulAdd = await runCrewSessionAddCommand(addOptions, context(root), {
			capture: async () => successfulOutcome,
			add: async () => successfulOutcome,
		});
		assert.equal(successfulAdd.kind, "result");
		if (successfulAdd.kind === "result") assert.equal(successfulAdd.result.status, "partial");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
