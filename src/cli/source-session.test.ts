import assert from "node:assert/strict";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSourceSession } from "./source-session.ts";

const CONTROL_DIR = path.join(os.homedir(), ".pi", "bebop");

test("explicit --session session id wins and maps to id-then-alias candidate paths", () => {
	const resolution = resolveSourceSession({ explicitSession: "abc-123", environmentSession: "env-1" });
	assert.equal(resolution.ok, true);
	if (!resolution.ok) return;
	assert.equal(resolution.kind, "id");
	assert.equal(resolution.idSocketPath, path.join(CONTROL_DIR, "abc-123.sock"));
	assert.equal(resolution.aliasSocketPath, path.join(CONTROL_DIR, "abc-123.alias"));
});

test("explicit --session alias-shaped value resolves as id-first with alias fallback path", () => {
	const resolution = resolveSourceSession({ explicitSession: "intra-proj-branch-main-1" });
	assert.equal(resolution.ok, true);
	if (!resolution.ok) return;
	assert.equal(resolution.kind, "id");
	assert.equal(resolution.idSocketPath, path.join(CONTROL_DIR, "intra-proj-branch-main-1.sock"));
	assert.equal(resolution.aliasSocketPath, path.join(CONTROL_DIR, "intra-proj-branch-main-1.alias"));
});

test("explicit unsafe value is invalid-session and never falls back to the environment", () => {
	for (const unsafe of ["a/b", "..\\x", ".."]) {
		const resolution = resolveSourceSession({ explicitSession: unsafe, environmentSession: "env-1" });
		assert.equal(resolution.ok, false, unsafe);
		if (resolution.ok) continue;
		assert.equal(resolution.code, "invalid-session", unsafe);
		assert.match(resolution.message, /Invalid --session/, unsafe);
	}
});

test("explicit empty value is treated as absent and the environment fallback applies", () => {
	const resolution = resolveSourceSession({ explicitSession: "", environmentSession: "env-9" });
	assert.equal(resolution.ok, true);
	if (!resolution.ok) return;
	assert.equal(resolution.idSocketPath, path.join(CONTROL_DIR, "env-9.sock"));
});

test("environment PI_SESSION_ID fallback resolves as an exact session id only", () => {
	const resolution = resolveSourceSession({ environmentSession: "env-7" });
	assert.equal(resolution.ok, true);
	if (!resolution.ok) return;
	assert.equal(resolution.kind, "id");
	assert.equal(resolution.idSocketPath, path.join(CONTROL_DIR, "env-7.sock"));
});

test("unsafe environment value is invalid-session", () => {
	for (const unsafe of ["a/b", ".."]) {
		const resolution = resolveSourceSession({ environmentSession: unsafe });
		assert.equal(resolution.ok, false, unsafe);
		if (resolution.ok) continue;
		assert.equal(resolution.code, "invalid-session", unsafe);
		assert.match(resolution.message, /PI_SESSION_ID/, unsafe);
	}
});

test("without explicit or environment source, session-required carries the discovery hint", () => {
	const resolution = resolveSourceSession({});
	assert.equal(resolution.ok, false);
	if (resolution.ok) return;
	assert.equal(resolution.code, "session-required");
	assert.match(resolution.message, /pi-bebop session list/);
});
