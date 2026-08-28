import test from "node:test";
import assert from "node:assert/strict";
import { actionableErrorUtf8Bytes, presentActionableError } from "./actionable-error.ts";

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

test("presentActionableError uses UTF-8 bounds and never leaks controls", () => {
	const error = presentActionableError({
		code: "unexpected-failure",
		operation: "é".repeat(200),
		reason: "fact\u0001\u0001",
		recovery: ["next\u0001", "collect evidence"],
		location: { kind: "argument", name: "member", value: "safe\u0001" },
		validChoices: ["one\u0001", "two"],
	});
	assert.ok(Buffer.byteLength(error.operation, "utf8") <= 96);
	assert.ok(Buffer.byteLength(error.message, "utf8") <= 1024);
	const emoji = presentActionableError({
		code: "offline",
		operation: "😀".repeat(100),
		reason: "unreachable",
		recovery: ["retry"],
	});
	assert.ok(Buffer.byteLength(emoji.operation, "utf8") <= 96);
	assert.equal(emoji.operation.endsWith("\uFFFD"), false);
	assert.ok(actionableErrorUtf8Bytes(error) <= 4096);
	assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(JSON.stringify(error)), false);
	assert.equal(error.location?.value, undefined);
	assert.deepEqual(error.validChoices, ["two"]);
});

test("detector-changed locations are omitted from the message and canonical object", () => {
	const error = presentActionableError({
		code: "offline",
		operation: "member status",
		reason: "endpoint unreachable",
		recovery: ["retry after checking Presence"],
		location: { kind: "transport", name: "endpoint", value: "https://user:password@example.test" },
	});
	assert.equal(error.location?.value, undefined);
	assert.equal(JSON.stringify(error).includes('"value"'), false);
	assert.equal(error.message.includes("password"), false);
	assert.equal(JSON.stringify(error).includes("example.test"), false);
});

test("full bounded presentation remains within canonical 4096-byte accounting", () => {
	const error = presentActionableError({
		code: "write-failed",
		operation: "o".repeat(96),
		reason: "r".repeat(240),
		recovery: ["a".repeat(256), "b".repeat(256), "c".repeat(256)],
		location: { kind: "project-path", name: "path".repeat(12), value: "V".repeat(384) },
		validChoices: Array.from({ length: 40 }, (_, index) => `choice-${index}`.repeat(8)),
	});
	assert.ok(actionableErrorUtf8Bytes(error) <= 4096);
	assert.ok(Buffer.byteLength(error.message, "utf8") <= 1024);
	if (error.location?.value === undefined) assert.equal(error.message.includes("V"), false);
	else assert.equal(error.message.includes(error.location.value.slice(0, 10)), true);
});
