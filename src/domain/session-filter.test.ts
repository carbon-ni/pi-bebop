import test from "node:test";
import assert from "node:assert/strict";

import { filterSessionsBySearch } from "./session-filter.ts";

const sessions = [
	{ sessionId: "abc123", name: "frontend", aliases: ["pi-intray-branch-main-1"], socketPath: "/tmp/abc.sock" },
	{ sessionId: "def456", name: "backend", aliases: ["api-branch-fix-1"], socketPath: "/tmp/def.sock" },
	{ sessionId: "ghi789", aliases: [], socketPath: "/tmp/ghi.sock" },
];

test("filterSessionsBySearch returns all sessions without search text", () => {
	assert.deepEqual(filterSessionsBySearch(sessions, undefined), sessions);
	assert.deepEqual(filterSessionsBySearch(sessions, "   "), sessions);
});

test("filterSessionsBySearch matches session id, name, and aliases case-insensitively", () => {
	assert.deepEqual(filterSessionsBySearch(sessions, "DEF"), [sessions[1]]);
	assert.deepEqual(filterSessionsBySearch(sessions, "front"), [sessions[0]]);
	assert.deepEqual(filterSessionsBySearch(sessions, "BRANCH-FIX"), [sessions[1]]);
});

test("filterSessionsBySearch returns empty when no session matches", () => {
	assert.deepEqual(filterSessionsBySearch(sessions, "missing"), []);
});
