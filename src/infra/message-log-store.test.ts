import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMessageLogStore, MessageLogStoreError } from "./message-log-store.ts";

const entry = {
	version: 1,
	kind: "message-event",
	id: "entry-1",
	occurredAt: "2026-08-28T00:00:00.000Z",
	surface: "follow-up",
	stage: "delivery",
	outcome: "queued",
	operation: { id: "op", lifecycleSequence: 1 },
	payload: {},
	errorCode: null,
	capture: {},
	semanticFingerprint: "x",
};
test("trusted message log append is replay-idempotent and rejects conflicts", async () => {
	const root = await mkdtemp(`${tmpdir()}/message-log-`);
	try {
		const store = createMessageLogStore({ root, isTrusted: () => true });
		await store.append(entry);
		await store.append(entry);
		assert.deepEqual(await store.read(entry.id), new TextEncoder().encode(JSON.stringify(entry)));
		await assert.rejects(
			() => store.append({ ...entry, outcome: "failed" }),
			(e) => e instanceof MessageLogStoreError && e.code === "id-conflict",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("untrusted message log fails before IO", async () => {
	const store = createMessageLogStore({ root: "/tmp/never-message-log", isTrusted: () => false });
	await assert.rejects(
		() => store.read("entry-1"),
		(e) => e instanceof MessageLogStoreError && e.code === "untrusted-project",
	);
});
