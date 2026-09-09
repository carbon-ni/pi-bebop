import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CrewManifest, CrewSessionRecord } from "../domain/index.ts";
import { addCrewSessionMember, captureCrewSession } from "./crew-session-capture.ts";
import type { CrewSessionStore } from "../infra/crew-session-store.ts";

const manifest: CrewManifest = {
	version: 2,
	crew: { id: "alpha", displayName: "Alpha" },
	members: [
		{ name: "Alice", role: "developer", socket: "/project/alice.sock", socketPath: "/project/alice.sock" },
		{ name: "Bob", role: "quality", socket: "/project/bob.sock", socketPath: "/project/bob.sock" },
	],
	presence: { notifications: true },
};

function memoryStore(initial: CrewSessionRecord[] = []): CrewSessionStore {
	const records = [...initial];
	return {
		rootDir: "/tmp/crew-sessions",
		list: async () => [...records],
		read: async (id) => {
			const found = records.find((record) => record.id === id);
			if (!found) throw new Error("record-not-found");
			return found;
		},
		write: async (record, options) => {
			const index = records.findIndex((candidate) => candidate.id === record.id);
			if (index >= 0 && options?.overwrite !== true) throw new Error("record-exists");
			if (index >= 0) records[index] = record;
			else records.push(record);
		},
	};
}

function captureResponse(name: string, role: string, id = `${name.toLowerCase()}-session`) {
	return {
		response: {
			type: "response",
			command: "session_capture",
			success: true,
			id: "rpc-test",
			data: {
				crewLocator: "/project/.pi/bebop/crew.json",
				crew: { id: "alpha", displayName: "Alpha" },
				member: { name, role },
				session: {
					persisted: true,
					id,
					file: `/sessions/${id}.jsonl`,
					cwd: "/project",
					root: "/sessions",
				},
			},
		},
	};
}

function deps(store: CrewSessionStore, responses: Record<string, unknown>) {
	return {
		store,
		readManifest: async () => manifest,
		resolveEndpoint: async (socket: string) => socket,
		sendCapture: async (socket: string) =>
			responses[socket] ??
			captureResponse(
				socket.includes("alice") ? "Alice" : "Bob",
				socket.includes("alice") ? "developer" : "quality",
			),
		validateSession: async () => undefined,
		now: () => new Date("2026-09-09T12:00:00.000Z"),
		createId: () => "cs_0123456789abcdef",
	};
}

test("capture stores complete or explicit partial records in manifest order", async () => {
	const store = memoryStore();
	const outcome = await captureCrewSession(
		{ name: "auth regression", manifestPath: "/project/.pi/bebop/crew.json", projectRoot: "/project" },
		deps(store, {
			"/project/bob.sock": {
				response: {
					type: "response",
					command: "session_capture",
					success: false,
					id: "rpc-test",
					error: "offline",
				},
			},
		}),
	);
	assert.equal("record" in outcome, true);
	if (!("record" in outcome)) return;
	assert.equal(outcome.record.state, "partial");
	assert.deepEqual(
		outcome.record.members.map((member) => member.status),
		["captured", "missing"],
	);
	assert.equal(outcome.record.members[1]?.status === "missing" && outcome.record.members[1].reason, "offline");
	assert.equal((await store.list()).length, 1);
});

test("capture-empty writes no record", async () => {
	const store = memoryStore();
	const outcome = await captureCrewSession(
		{ name: "empty", manifestPath: "/project/.pi/bebop/crew.json", projectRoot: "/project" },
		{
			...deps(store, {}),
			sendCapture: async () =>
				({
					response: {
						type: "response",
						command: "session_capture",
						success: false,
						id: "rpc-test",
						error: "offline",
					},
				}) as never,
		},
	);
	assert.equal("code" in outcome && outcome.code, "capture-empty");
	assert.deepEqual(await store.list(), []);
});

test("addition fills only a previously missing Member and preserves other links", async () => {
	const initial = await captureCrewSession(
		{ name: "partial", manifestPath: "/project/.pi/bebop/crew.json", projectRoot: "/project" },
		{
			...deps(memoryStore(), {}),
			sendCapture: async (socket: string) =>
				socket.includes("alice")
					? captureResponse("Alice", "developer")
					: ({
							response: {
								type: "response",
								command: "session_capture",
								success: false,
								id: "rpc-test",
								error: "offline",
							},
						} as never),
		},
	);
	assert.equal("record" in initial, true);
	if (!("record" in initial)) return;
	const store = memoryStore([initial.record]);
	const outcome = await addCrewSessionMember(
		{
			id: initial.record.id,
			memberName: "Bob",
			manifestPath: "/project/.pi/bebop/crew.json",
			projectRoot: "/project",
		},
		{ ...deps(store, {}), sendCapture: async () => captureResponse("Bob", "quality") as never },
	);
	assert.equal("record" in outcome, true);
	if (!("record" in outcome)) return;
	assert.deepEqual(
		outcome.record.members.map((member) => member.status),
		["captured", "captured"],
	);
	assert.equal(outcome.record.members[0]?.piSessionId, "alice-session");
});
