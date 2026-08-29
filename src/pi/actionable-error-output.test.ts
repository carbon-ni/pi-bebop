import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActionableErrorDescriptor } from "../domain/index.ts";
import { reportActionableError } from "./actionable-error-output.ts";

function context(hasUI: boolean, notify: (message: string, level: "error") => void): ExtensionContext {
	return {
		hasUI,
		ui: { notify },
	} as ExtensionContext;
}

const descriptor: ActionableErrorDescriptor = {
	code: "unknown-target",
	operation: "Crew startup send",
	reason: "the target session is not configured",
	recovery: ["check the target and retry."],
};

test("actionable error output presents one canonical message to UI and headless sinks", () => {
	const notices: string[] = [];
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (message: string) => errors.push(message);
	try {
		reportActionableError(
			context(true, (message) => notices.push(message)),
			descriptor,
		);
		reportActionableError(
			context(false, () => undefined),
			descriptor,
		);
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(notices, [
		"Crew startup send failed: the target session is not configured. Next: check the target and retry. (code: unknown-target)",
	]);
	assert.deepEqual(errors, notices);
});

test("null context uses the same canonical headless error sink", () => {
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (message: string) => errors.push(message);
	try {
		reportActionableError(null, descriptor);
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(errors, [
		"Crew startup send failed: the target session is not configured. Next: check the target and retry. (code: unknown-target)",
	]);
});

test("actionable error output sanitizes untrusted descriptor fields before either sink", () => {
	const notices: string[] = [];
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (message: string) => errors.push(message);
	const unsafe: ActionableErrorDescriptor = {
		code: "unknown-target",
		operation: "Crew startup send",
		reason: "private/tmp/startup-secret\nAuthorization: Bearer hidden-token",
		recovery: ["retry safely."],
		location: { kind: "project-path", name: "target", value: "/private/tmp/startup.sock" },
	};
	try {
		reportActionableError(
			context(true, (message) => notices.push(message)),
			unsafe,
		);
		reportActionableError(
			context(false, () => undefined),
			unsafe,
		);
	} finally {
		console.error = originalError;
	}
	assert.equal(notices.length, 1);
	assert.deepEqual(errors, notices);
	assert.match(notices[0]!, /an unexpected failure occurred/);
	assert.doesNotMatch(notices[0]!, /private\/tmp|startup-secret|hidden-token|Bearer/);
});
