import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewManifest, CrewSessionRecord } from "../domain/index.ts";
import { listCrewSessions, showCrewSession } from "./crew-session-inspection.ts";
import type { CrewSessionStore, CrewSessionStoreEntry } from "../infra/crew-session-store.ts";

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
		manifestFingerprint: "wrong",
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
function store(entries: readonly CrewSessionStoreEntry[]): CrewSessionStore {
	return {
		rootDir: "/sessions",
		list: async () => [record],
		listDetailed: async () => entries,
		read: async () => record,
		write: async () => undefined,
	};
}
function deps(entries: readonly CrewSessionStoreEntry[]) {
	return {
		store: store(entries),
		readManifest: async () => manifest,
		access: async () => undefined,
		validateSession: async () => undefined,
	};
}

test("list is bounded, ordered, redacted, and read-only", async () => {
	let calls = 0;
	const result = await listCrewSessions(
		{ projectRoot: "/project", limit: 1 },
		{
			...deps([{ id: record.id, record }]),
			access: async () => {
				calls += 1;
			},
		},
	);
	assert.equal(result.total, 1);
	assert.equal(result.returned, 1);
	assert.equal(result.sessions[0]?.status, "stale");
	assert.equal(result.sessions[0]?.id, record.id);
	assert.equal(JSON.stringify(result.sessions).includes("pi-session-secret"), false);
	assert.equal(calls, 0);
});

test("list isolates corrupt entries and validates exact trusted filters", async () => {
	const result = await listCrewSessions(
		{ projectRoot: "/project" },
		deps([
			{ id: "bad", invalid: true, code: "invalid-record" },
			{ id: record.id, record },
		]),
	);
	assert.deepEqual(
		result.sessions.map((item) => item.status),
		["invalid", "stale"],
	);
	await assert.rejects(
		() => listCrewSessions({ projectRoot: "/project", crewLocator: "/tmp/foreign.json" }, deps([])),
		/outside trusted/,
	);
});

test("show exposes exact session references only for explicit inspection", async () => {
	const result = await showCrewSession(record.id, { projectRoot: "/project" }, deps([{ id: record.id, record }]));
	assert.equal(result.state, "stale");
	assert.equal(result.members[0]?.piSessionId, "pi-session-secret");
	assert.equal(result.members[0]?.persistedSessionFile, "/sessions/alice.jsonl");
	assert.equal(result.members[0]?.activeProcess, "unknown");
	await assert.rejects(() => showCrewSession("cs_missing", { projectRoot: "/project" }, deps([])), /not found/);
});
