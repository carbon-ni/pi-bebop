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
		payload: {
			state: "represented",
			reason: null,
			content: {
				state: "captured",
				reason: null,
				text: "",
				normalizedUtf8Bytes: 0,
				retainedUtf8Bytes: 0,
				omittedUtf8Bytes: 0,
				truncated: false,
				escapedMarkerCount: 0,
				redactions: [],
			},
			instructions: [],
			instructionCount: 0,
		},
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
		payload: { ...entry.payload, instructionCount: 0, instructions: [], state: "represented" },
	};
	assert.deepEqual(canonicalMessageLogEntryBytes(entry), canonicalMessageLogEntryBytes(reordered));
	assert.throws(() => canonicalMessageLogEntryBytes({ ...entry, secret: "raw" }), /unknown-message-log-field/);
	assert.throws(() => canonicalMessageLogEntryBytes({ ...entry, outcome: "bogus" }), /invalid-message-log-schema/);
	assert.throws(() => canonicalMessageLogEntryBytes({ ...entry, outcome: Number.NaN }), /invalid-message-log-schema/);
	assert.throws(
		() => canonicalMessageLogEntryBytes({ ...entry, payload: { ...entry.payload, content: undefined } }),
		/invalid-message-log-payload/,
	);
	assert.throws(
		() => canonicalMessageLogEntryBytes({ ...entry, operation: { ...entry.operation, secret: true } }),
		/invalid-message-log-operation/,
	);
	assert.throws(
		() => canonicalMessageLogEntryBytes({ ...entry, payload: { ...entry.payload, instructionCount: 1 } }),
		/invalid-message-log-payload/,
	);
	assert.throws(
		() =>
			canonicalMessageLogEntryBytes({
				...entry,
				payload: {
					state: "unavailable",
					reason: "invalid-payload",
					content: {
						state: "unavailable",
						reason: "invalid-payload",
						text: null,
						normalizedUtf8Bytes: null,
						retainedUtf8Bytes: 0,
						omittedUtf8Bytes: null,
						truncated: false,
						escapedMarkerCount: 0,
						redactions: [],
					},
					instructions: [{ state: "captured" }],
					instructionCount: null,
				},
			}),
		/invalid-message-log-payload/,
	);
	assert.throws(
		() =>
			canonicalMessageLogEntryBytes({
				...entry,
				stage: "persistence",
				payload: null,
			}),
		/invalid-message-log-surface-stage-outcome/,
	);
	assert.throws(
		() =>
			canonicalMessageLogEntryBytes({
				...entry,
				stage: "handoff",
				outcome: "redirected",
				payload: { ...entry.payload },
			}),
		/invalid-message-log-surface-stage-outcome/,
	);
	assert.throws(
		() =>
			canonicalMessageLogEntryBytes({
				...entry,
				stage: "delivery",
				outcome: "queued",
				payload: null,
			}),
		/invalid-message-log-payload/,
	);
	assert.throws(
		() => canonicalMessageLogEntryBytes({ ...entry, occurredAt: "2026-08-28 00:00:00Z" }),
		/invalid-message-log-timestamp/,
	);
	assert.throws(
		() =>
			canonicalMessageLogEntryBytes({
				...entry,
				occurredAt: "2026-08-28T00:00:00.000+01:00",
			}),
		/invalid-message-log-timestamp/,
	);
	assert.throws(
		() =>
			canonicalMessageLogEntryBytes({
				...entry,
				capture: { ...entry.capture, capturedAt: "2026-08-28 00:00:00Z" },
			}),
		/invalid-message-log-timestamp/,
	);
	assert.throws(
		() => canonicalMessageLogEntryBytes({ ...entry, operation: { ...entry.operation, lifecycleSequence: 0 } }),
		/invalid-message-log-operation/,
	);
	assert.throws(
		() => canonicalMessageLogEntryBytes({ ...entry, capture: { ...entry.capture, attemptSequence: 0 } }),
		/invalid-message-log-capture/,
	);
});

test("valid matrix cells keep payload shape contract", () => {
	const entryWithNullPayload = {
		version: 1,
		kind: "message-event",
		id: "entry-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		occurredAt: "2026-08-28T00:00:00.000Z",
		surface: "member-inbox",
		stage: "handoff",
		outcome: "offered",
		operation: {
			id: "op-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			lifecycleSequence: 1,
		},
		payload: null,
		errorCode: null,
		capture: {
			endpointId: "endpoint-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			epochId: "epoch-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			attemptSequence: 1,
			capturedAt: "2026-08-28T00:00:00.000Z",
		},
		semanticFingerprint: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
	};
	assert.equal(canonicalMessageLogEntryBytes(entryWithNullPayload).length > 0, true);
});

test("invalid: non-payload stages require null payload", () => {
	const memberInboxPersistence = {
		version: 1,
		kind: "message-event",
		id: "entry-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		occurredAt: "2026-08-28T00:00:00.000Z",
		surface: "member-inbox",
		stage: "persistence",
		outcome: "persisted",
		operation: {
			id: "op-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			lifecycleSequence: 1,
		},
		payload: null,
		errorCode: null,
		capture: {
			endpointId: "endpoint-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			epochId: "epoch-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			attemptSequence: 1,
			capturedAt: "2026-08-28T00:00:00.000Z",
		},
		semanticFingerprint: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
	};
	assert.throws(() => canonicalMessageLogEntryBytes(memberInboxPersistence), /invalid-message-log-payload/);
});
