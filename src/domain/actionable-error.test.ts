import test from "node:test";
import assert from "node:assert/strict";
import { presentActionableError } from "./actionable-error.ts";

test("presentActionableError builds deterministic canonical text", () => {
	const error = presentActionableError({
		code: "unknown-member",
		operation: "pi-bebop member status",
		reason: "target is unknown",
		recovery: ["run crew roles"],
		location: { kind: "argument", name: "member", value: "Ghost" },
	});
	assert.equal(
		error.message,
		'pi-bebop member status failed: target is unknown. Location: member="Ghost". Next: run crew roles (code: unknown-member)',
	);
});

test("presentActionableError redacts unsafe fields and bounds choices", () => {
	const error = presentActionableError({
		code: "write-failed",
		operation: "Board append",
		reason: "token=secret",
		recovery: ["retry\nnow", "retry safely"],
		validChoices: ["a", "a", ...Array.from({ length: 40 }, (_, i) => `choice-${i}`)],
	});
	assert.equal(error.message.includes("secret"), false);
	assert.deepEqual(error.validChoices?.slice(0, 2), ["a", "choice-0"]);
	assert.equal(error.validChoicesTruncated, true);
});
