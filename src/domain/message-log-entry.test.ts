import test from "node:test";
import assert from "node:assert/strict";
import { canonicalMessageLogEntryBytes } from "./message-log-entry.ts";

test("message event canonical bytes require closed v1 envelope", () => {
	const entry = {
		version: 1,
		kind: "message-event",
		id: "entry-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		occurredAt: "2026-08-28T00:00:00.000Z",
		surface: "follow-up",
		stage: "delivery",
		outcome: "queued",
		operation: { id: "op-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", lifecycleSequence: 1 },
		payload: { state: "represented", instructions: [], instructionCount: 0 },
		errorCode: null,
		capture: {
			endpointId: "endpoint-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			epochId: "epoch-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			attemptSequence: 1,
			capturedAt: "2026-08-28T00:00:00.000Z",
		},
		semanticFingerprint: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
	};
	assert.ok(canonicalMessageLogEntryBytes(entry).byteLength > 0);
	assert.equal(canonicalMessageLogEntryBytes(entry).at(-1), 10);
	const reordered = {
		...entry,
		operation: { lifecycleSequence: 1, id: entry.operation.id },
		payload: { instructionCount: 0, instructions: [], state: "represented" },
	};
	assert.deepEqual(canonicalMessageLogEntryBytes(entry), canonicalMessageLogEntryBytes(reordered));
	assert.throws(() => canonicalMessageLogEntryBytes({ ...entry, secret: "raw" }), /unknown-message-log-field/);
	assert.throws(() => canonicalMessageLogEntryBytes({ ...entry, outcome: Number.NaN }), /invalid-message-log-value/);
	assert.throws(
		() => canonicalMessageLogEntryBytes({ ...entry, payload: { ...entry.payload, content: undefined } }),
		/invalid-message-log-value/,
	);
	assert.throws(
		() => canonicalMessageLogEntryBytes({ ...entry, operation: { ...entry.operation, secret: true } }),
		/invalid-message-log-operation/,
	);
	assert.throws(
		() => canonicalMessageLogEntryBytes({ ...entry, payload: { ...entry.payload, instructionCount: 1 } }),
		/invalid-message-log-payload/,
	);
});
