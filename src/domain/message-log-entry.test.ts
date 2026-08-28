import test from "node:test";
import assert from "node:assert/strict";
import { canonicalMessageLogEntryBytes } from "./message-log-entry.ts";

test("message event canonical bytes require closed v1 envelope", () => {
	const entry = {
		version: 1,
		kind: "message-event",
		id: "entry-x",
		occurredAt: "2026-08-28T00:00:00.000Z",
		surface: "follow-up",
		stage: "delivery",
		outcome: "queued",
		operation: { id: "op-x", lifecycleSequence: 1 },
		payload: { state: "represented", instructions: [], instructionCount: 0 },
		errorCode: null,
		capture: {
			endpointId: "endpoint-x",
			epochId: "epoch-x",
			attemptSequence: 1,
			capturedAt: "2026-08-28T00:00:00.000Z",
		},
		semanticFingerprint: "x",
	};
	assert.ok(canonicalMessageLogEntryBytes(entry).byteLength > 0);
	assert.equal(canonicalMessageLogEntryBytes(entry).at(-1), 10);
	assert.throws(() => canonicalMessageLogEntryBytes({ ...entry, secret: "raw" }), /unknown-message-log-field/);
});
