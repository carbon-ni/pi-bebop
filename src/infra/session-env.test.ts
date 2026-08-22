import test from "node:test";
import assert from "node:assert/strict";

import { getSessionEnvValue, updateProcessSessionEnv } from "./session-env.ts";

test("getSessionEnvValue returns session id when enabled", () => {
	assert.equal(getSessionEnvValue(true, "session-1"), "session-1");
});

test("getSessionEnvValue returns undefined when disabled", () => {
	assert.equal(getSessionEnvValue(false, "session-1"), undefined);
});

test("getSessionEnvValue returns undefined when enabled without session id", () => {
	assert.equal(getSessionEnvValue(true), undefined);
});

test("updateProcessSessionEnv sets session id when enabled", () => {
	const previous = process.env.PI_SESSION_ID;
	try {
		updateProcessSessionEnv(true, "session-1");

		assert.equal(process.env.PI_SESSION_ID, "session-1");
	} finally {
		if (previous === undefined) delete process.env.PI_SESSION_ID;
		else process.env.PI_SESSION_ID = previous;
	}
});

test("updateProcessSessionEnv clears session id when disabled", () => {
	const previous = process.env.PI_SESSION_ID;
	try {
		process.env.PI_SESSION_ID = "session-1";

		updateProcessSessionEnv(false, "session-1");

		assert.equal(process.env.PI_SESSION_ID, undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_SESSION_ID;
		else process.env.PI_SESSION_ID = previous;
	}
});
