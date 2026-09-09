import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewManifest, CrewSessionRecord } from "../domain/index.ts";
import { manifestFingerprint, type CrewSessionStore, type CrewSessionStoreEntry } from "../infra/crew-session-store.ts";
import { resolveCrewSessionMember, resolutionCommand } from "./crew-session-resolution.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

const manifest: CrewManifest = {
	version: 2,
	crew: { id: "alpha", displayName: "Alpha" },
	members: [
		{ name: "Alice", role: "developer", socket: "sockets/alice.sock", socketPath: "/project/sockets/alice.sock" },
	],
	presence: { notifications: true },
};
const record: CrewSessionRecord = {
	schemaVersion: 1,
	id: "cs_0123456789abcdef",
	name: "auth regression",
	crew: {
		selector: "alpha",
		displayName: "Alpha",
		locator: "/project/.pi/bebop/crew.json",
		manifestFingerprint: manifestFingerprint(manifest),
	},
	createdAt: "2026-09-09T12:00:00.000Z",
	state: "complete",
	members: [
		{
			name: "Alice",
			role: "developer",
			status: "captured",
			piSessionId: "pi-session-secret",
			persistedSessionFile: "/sessions/alice.jsonl",
			sessionCwd: "/project",
			sessionRoot: "/sessions",
			capturedAt: "2026-09-09T12:00:00.000Z",
		},
	],
};

function manager(active = true): SessionManager {
	return {
		getHeader: () => ({ type: "session", id: "pi-session-secret", timestamp: "", cwd: "/project" }),
		getSessionDir: () => "/sessions",
		getBranch: () =>
			active
				? [
						{
							type: "custom",
							customType: "intray-membership",
							data: {
								active: true,
								socketPath: "/project/sockets/alice.sock",
								manifestPath: "/project/.pi/bebop/crew.json",
							},
						},
					]
				: [],
	} as unknown as SessionManager;
}

function deps(overrides: Partial<Parameters<typeof resolveCrewSessionMember>[1]> = {}) {
	const entries: readonly CrewSessionStoreEntry[] = [{ id: record.id, record }];
	const store: CrewSessionStore = {
		rootDir: "/tmp/crew-sessions",
		list: async () => [record],
		listDetailed: async () => entries,
		read: async () => record,
		write: async () => undefined,
	};
	return {
		store,
		readManifest: async () => manifest,
		access: async () => undefined,
		validateSession: async () => undefined,
		probe: async () => false,
		openSession: async () => manager(),
		readDirectory: async () => [],
		...overrides,
	};
}

test("resolves an exact Member to separate argv and cwd without launching Pi", async () => {
	const result = await resolveCrewSessionMember(
		{ projectRoot: "/project", id: record.id, memberName: "Alice" },
		deps(),
	);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(result.startup.argv, ["pi", "--session", "/sessions/alice.jsonl"]);
		assert.equal(result.startup.cwd, "/project");
		assert.match(resolutionCommand(result), /^'pi' '--session' '\/sessions\/alice\.jsonl'$/);
	}
});

test("refuses an already-open or inactive exact session", async () => {
	const open = await resolveCrewSessionMember(
		{ projectRoot: "/project", id: record.id, memberName: "Alice" },
		deps({ probe: async () => true }),
	);
	assert.equal(open.ok, false);
	if (!open.ok) assert.equal(open.code, "already-open");
	const inactive = await resolveCrewSessionMember(
		{ projectRoot: "/project", id: record.id, memberName: "Alice" },
		deps({ openSession: async () => manager(false) }),
	);
	assert.equal(inactive.ok, false);
	if (!inactive.ok) assert.equal(inactive.code, "membership-inactive");
});

test("requires exact case-sensitive Member and Crew Session identity", async () => {
	const result = await resolveCrewSessionMember(
		{ projectRoot: "/project", id: record.id, memberName: "alice" },
		deps(),
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "member-not-configured");
	const missing = await resolveCrewSessionMember(
		{ projectRoot: "/project", id: "cs_missing", memberName: "Alice" },
		deps({ store: { ...deps().store, listDetailed: async () => [] } }),
	);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.equal(missing.code, "record-not-found");
});
