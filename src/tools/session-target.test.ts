import test from "node:test";
import assert from "node:assert/strict";
import { parseCrewManifest } from "../domain/index.ts";
import { getSocketPath } from "../infra/intray-paths.ts";
import { resolveSessionTarget, SessionTargetError } from "./session-target.ts";

const manifestPath = "/project/.pi/intray/crew.json";
const manifest = parseCrewManifest({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }, manifestPath);

function deps(overrides: Partial<Parameters<typeof resolveSessionTarget>[1]> = {}) {
	return {
		resolveAlias: async (name: string) => name === "dev" ? "target-id" : null,
		loadManifest: async () => manifest,
		readlink: async () => "/home/.pi/intray/target-id.sock",
		...overrides,
	};
}

test("resolves @ socket paths relative to execution cwd through the manifest", async () => {
	const target = await resolveSessionTarget({ socketPath: "@.pi/intray/sockets/dev.sock", cwd: "/project", isProjectTrusted: () => true }, deps());
	assert.equal(target.socketPath, "/project/.pi/intray/sockets/dev.sock");
	assert.equal(target.displayTarget, target.socketPath);
});

test("distinguishes unknown configured members and validates optional session identity", async () => {
	await assert.rejects(
		() => resolveSessionTarget({ socketPath: "/project/.pi/intray/sockets/missing.sock", cwd: "/project", isProjectTrusted: () => true }, deps()),
		(error: unknown) => error instanceof SessionTargetError && error.code === "unknown-member",
	);
	await assert.rejects(
		() => resolveSessionTarget({ socketPath: "/project/.pi/intray/sockets/dev.sock", sessionId: "other-id", cwd: "/project", isProjectTrusted: () => true }, deps()),
		(error: unknown) => error instanceof SessionTargetError && error.code === "target-mismatch",
	);
});

test("preserves id and alias target resolution", async () => {
	const byId = await resolveSessionTarget({ sessionId: "target-id", cwd: "/project", isProjectTrusted: () => true }, deps());
	assert.equal(byId.socketPath, getSocketPath("target-id"));
	const byName = await resolveSessionTarget({ sessionName: "dev", cwd: "/project", isProjectTrusted: () => true }, deps());
	assert.equal(byName.sessionId, "target-id");
});
