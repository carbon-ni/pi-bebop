import test from "node:test";
import assert from "node:assert/strict";
import { isIntrayEnabledByConfig } from "./intray-config.ts";

test("isIntrayEnabledByConfig returns true when startByDefault is true", () => {
	const read = (_path: string) => JSON.stringify({ startByDefault: true });
	assert.equal(isIntrayEnabledByConfig(read), true);
});

test("isIntrayEnabledByConfig returns false when startByDefault is false", () => {
	const read = (_path: string) => JSON.stringify({ startByDefault: false });
	assert.equal(isIntrayEnabledByConfig(read), false);
});

test("isIntrayEnabledByConfig returns false when startByDefault is missing", () => {
	const read = (_path: string) => JSON.stringify({});
	assert.equal(isIntrayEnabledByConfig(read), false);
});

test("isIntrayEnabledByConfig returns false when file is missing", () => {
	let called = false;
	const read = (_path: string) => {
		called = true;
		const err = new Error("ENOENT") as Error & { code: string };
		err.code = "ENOENT";
		throw err;
	};
	assert.equal(isIntrayEnabledByConfig(read), false);
	assert.equal(called, true);
});

test("isIntrayEnabledByConfig throws on unexpected errors", () => {
	const read = (_path: string) => {
		throw new Error("permission denied");
	};
	assert.throws(() => isIntrayEnabledByConfig(read), { message: "permission denied" });
});

test("isIntrayEnabledByConfig returns false when JSON is malformed", () => {
	const read = (_path: string) => "{not json}";
	assert.equal(isIntrayEnabledByConfig(read), false);
});
