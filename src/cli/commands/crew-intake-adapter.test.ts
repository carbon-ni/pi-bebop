import assert from "node:assert/strict";
import test from "node:test";
import { deliverCrewIntake, type CrewIntakeDependencies } from "./crew-intake-adapter.ts";
import type { SendCliOptions } from "../arguments.ts";
import type { CliContext } from "../context.ts";
import { PassThrough } from "node:stream";

function options(overrides: Partial<SendCliOptions> = {}): SendCliOptions {
	return {
		command: "send",
		crewPath: "/project/.pi/bebop/crew.json",
		instructions: ["evaluate"],
		origin: { kind: "external", label: "jira-automation" },
		stdin: false,
		mode: "steer",
		wait: "turn_end",
		timeoutMs: 5000,
		format: "json",
		full: false,
		...overrides,
	};
}

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

test("intake submits the typed request with claimed origin and maps the ack", async () => {
	const captured: Array<{ request: unknown; deps: unknown }> = [];
	const deps: CrewIntakeDependencies = {
		submit: async (request, dependencies) => {
			captured.push({ request, deps: dependencies });
			return { ok: true, itemId: "inbox-1", persisted: true, contact: "Mary", contactRole: "po" };
		},
	};
	const outcome = await deliverCrewIntake(options(), "evaluate this request", context(), deps);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "persisted");
	assert.equal(outcome.result.target, "/project/.pi/bebop/crew.json");
	const data = outcome.result.data as { contact: string; contactRole: string; itemId: string };
	assert.equal(data.contact, "Mary");
	assert.equal(data.contactRole, "po");
	assert.equal(data.itemId, "inbox-1");
	assert.deepEqual(captured[0]?.request, {
		manifestPath: "/project/.pi/bebop/crew.json",
		label: "jira-automation",
		content: "evaluate this request",
		instructions: ["evaluate"],
	});
	const deps_ = captured[0]?.deps as { loadManifest: (p: string) => Promise<unknown>; openStore: unknown };
	assert.equal(typeof deps_?.loadManifest, "function");
	assert.equal(typeof deps_?.openStore, "function");
});

test("intake omits instructions when none are supplied", async () => {
	const captured: Array<{ request: { instructions?: readonly string[] } }> = [];
	const deps: CrewIntakeDependencies = {
		submit: async (request) => {
			captured.push({ request: request as { instructions?: readonly string[] } });
			return { ok: true, itemId: "inbox-2", persisted: true, contact: "Mary", contactRole: "po" };
		},
	};
	await deliverCrewIntake(options({ instructions: [], origin: undefined }), "hello", context(), deps);
	assert.equal(captured[0]?.request.instructions, undefined);
});

test("manifest load failures propagate as typed intake errors", async () => {
	// Real submit + real loader: a manifest outside the exact supported layout
	// is rejected before any store IO.
	await assert.rejects(deliverCrewIntake(options({ crewPath: "/tmp/elsewhere/crew.json" }), "hello", context()), {
		code: "untrusted-path",
	});
});
