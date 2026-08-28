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
		payload: {},
		errorCode: null,
		capture: {},
		semanticFingerprint: "x",
	};
	assert.ok(canonicalMessageLogEntryBytes(entry).byteLength > 0);
	assert.throws(() => canonicalMessageLogEntryBytes({ ...entry, secret: "raw" }), /unknown-message-log-field/);
});
