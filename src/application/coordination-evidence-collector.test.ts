import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	collectCoordinationEvidence,
	collectSingleCoordinationEvent,
	coordinationSourceGap,
	COORDINATION_COLLECTOR_ID,
} from "./coordination-evidence-collector.ts";
import { type CoordinationEvent, type CoordinationOutcomeKind } from "../domain/coordination-evidence.ts";
import {
	orderAndDeduplicateRetrospectiveEvidence,
	canonicalRetrospectiveEvidenceFingerprintInput,
	type RetrospectiveEvidence,
} from "../domain/index.ts";

const INTERVAL = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
const FIXED_FINGERPRINT = (input: string) => {
	// Deterministic test fingerprint
	let hash = 0;
	for (let i = 0; i < input.length; i++) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
	return Math.abs(hash).toString(16).padStart(64, "0");
};

function makeEvent(overrides: Partial<CoordinationEvent> = {}): CoordinationEvent {
	return {
		source: { family: "member-request", identity: "req-1", reference: "ref-1" },
		outcome: "member-request-response",
		occurredAt: "2026-01-01T00:30:00.000Z",
		...overrides,
	};
}

describe("coordination-evidence-collector", () => {
	describe("collectCoordinationEvidence", () => {
		it("collects a single event into evidence", () => {
			const event = makeEvent({
				source: { family: "member-request", identity: "req-42", reference: "ref" },
				outcome: "member-request-response",
				correlationId: "req-42",
			});
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 1);
			assert.equal(result.rejected.length, 0);
			assert.equal(result.items[0]!.source.kind, "bebop-coordination");
			assert.equal(result.items[0]!.availability, "captured");
		});

		it("rejects events outside the interval", () => {
			const event = makeEvent({ occurredAt: "2025-12-31T23:59:00.000Z" });
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 0);
			assert.equal(result.rejected.length, 1);
			assert.ok(result.rejected[0]!.reason.includes("outside interval"));
		});

		it("rejects events at or after interval end", () => {
			const event = makeEvent({ occurredAt: "2026-01-01T01:00:00.000Z" });
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 0);
			assert.equal(result.rejected.length, 1);
		});

		it("rejects events with non-mechanical context", () => {
			const event = makeEvent({
				context: {
					productive: true,
				} as unknown as import("../domain/coordination-evidence.ts").CoordinationMechanicalContext,
			});
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 0);
			assert.equal(result.rejected.length, 1);
			assert.ok(result.rejected[0]!.reason.includes("non-mechanical"));
		});

		it("accepts valid mechanical context (idle)", () => {
			const event = makeEvent({ context: { idle: true } });
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 1);
		});

		it("deduplicates identical events through fingerprint", () => {
			const event = makeEvent({
				source: { family: "member-request", identity: "req-1", reference: "ref" },
				outcome: "member-request-response",
				correlationId: "req-1",
			});
			const result = collectCoordinationEvidence([event, event], INTERVAL, FIXED_FINGERPRINT);
			// Both produce the same evidence; dedup happens at store level via fingerprint
			assert.equal(result.items.length, 2); // collector doesn't dedup; store does
			assert.equal(result.items[0]!.fingerprint, result.items[1]!.fingerprint);
		});

		it("collects multiple event families in one interval", () => {
			const events: CoordinationEvent[] = [
				makeEvent({
					source: { family: "member-request", identity: "r1", reference: "ref" },
					outcome: "member-request-response",
					correlationId: "r1",
				}),
				makeEvent({
					source: { family: "interrupt", identity: "i1", reference: "ref" },
					outcome: "interrupt-handoff",
					correlationId: "i1",
				}),
				makeEvent({
					source: { family: "broadcast", identity: "b1", reference: "ref" },
					outcome: "broadcast-persisted",
					correlationId: "b1",
				}),
				makeEvent({
					source: { family: "inbox", identity: "mb1", reference: "ref" },
					outcome: "inbox-enqueued",
					correlationId: "mb1",
				}),
			];
			const result = collectCoordinationEvidence(events, INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 4);
			assert.equal(result.rejected.length, 0);
		});

		it("retains canonical IDs and outcome vocabulary", () => {
			const event = makeEvent({
				source: { family: "member-request", identity: "r1", reference: "ref" },
				outcome: "member-request-timeout-max-wait",
				correlationId: "r1",
			});
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 1);
			assert.ok(result.items[0]!.source.reference.includes("member-request-timeout-max-wait")); // only the full specific outcome
		});

		it("bounds content summary", () => {
			const longContent = "x".repeat(2000);
			const event = makeEvent({ contentSummary: longContent });
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 1);
			const text = result.items[0]!.representation!.text;
			assert.ok(text.length < longContent.length);
		});

		it("collects with no content summary (uses outcome as representation)", () => {
			const event = makeEvent({ contentSummary: undefined });
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 1);
			assert.equal(result.items[0]!.representation?.kind, "content");
			assert.ok(result.items[0]!.representation?.text.includes("member-request-response"));
		});
	});

	describe("coordinationSourceGap", () => {
		it("creates unavailable evidence for a missing source", () => {
			const input = coordinationSourceGap("member-request", "req-missing", "source rotated", INTERVAL);
			assert.equal(input.availability, "unavailable");
			assert.ok(input.gap !== undefined);
			assert.ok(input.gap!.reason.includes("source rotated"));
		});

		it("bounds gap reason", () => {
			const longReason = "y".repeat(2000);
			const input = coordinationSourceGap("inbox", "inbox-1", longReason, INTERVAL);
			assert.ok(input.gap!.reason.length < longReason.length);
		});
	});

	describe("collectSingleCoordinationEvent", () => {
		it("returns a single RetrospectiveEvidence", () => {
			const event = makeEvent({ correlationId: "solo" });
			const evidence = collectSingleCoordinationEvent(event, INTERVAL, FIXED_FINGERPRINT);
			assert.equal(evidence.version, 1);
			assert.equal(evidence.kind, "retrospective-evidence");
			assert.equal(evidence.source.kind, "bebop-coordination");
		});
	});

	describe("read-only guarantee", () => {
		it("collector never mutates input events", () => {
			const events: CoordinationEvent[] = [
				makeEvent({ contentSummary: "original" }),
				makeEvent({ contentSummary: "other" }),
			];
			const frozen = events.map((e) => ({ ...e }));
			collectCoordinationEvidence(events, INTERVAL, FIXED_FINGERPRINT);
			assert.deepEqual(events, frozen);
		});
	});

	describe("interval boundaries", () => {
		it("event exactly at interval start is included", () => {
			const event = makeEvent({ occurredAt: INTERVAL.start });
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 1);
		});

		it("event one ms before interval start is excluded", () => {
			const event = makeEvent({ occurredAt: "2025-12-31T23:59:59.999Z" });
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 0);
		});
	});

	describe("ordering and dedup via store fingerprint", () => {
		it("identical events produce identical fingerprints for store dedup", () => {
			const event = makeEvent({ correlationId: "dup" });
			const a = collectSingleCoordinationEvent(event, INTERVAL, FIXED_FINGERPRINT);
			const b = collectSingleCoordinationEvent(event, INTERVAL, FIXED_FINGERPRINT);
			assert.equal(
				canonicalRetrospectiveEvidenceFingerprintInput(a),
				canonicalRetrospectiveEvidenceFingerprintInput(b),
			);
			// Store-level dedup: same fingerprint = deduplicated
			const ordered = orderAndDeduplicateRetrospectiveEvidence([a, b]);
			assert.equal(ordered.length, 1);
		});
	});

	describe("outcome vocabulary distinctions", () => {
		it("member-request timeout reasons map to distinct outcomes", () => {
			const outcomes: CoordinationOutcomeKind[] = [
				"member-request-timeout-max-wait",
				"member-request-timeout-response-after-idle",
			];
			for (const outcome of outcomes) {
				const event = makeEvent({ outcome, correlationId: outcome });
				const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
				assert.equal(result.items.length, 1);
				assert.ok(result.items[0]!.source.reference.includes(outcome));
			}
		});

		it("broadcast outcomes are distinct per disposition", () => {
			const outcomes: CoordinationOutcomeKind[] = [
				"broadcast-persisted",
				"broadcast-already-persisted",
				"broadcast-failed",
			];
			const refs = new Set<string>();
			for (const outcome of outcomes) {
				const event = makeEvent({
					source: { family: "broadcast", identity: "b1", reference: "ref" },
					outcome,
					correlationId: `b1-${outcome}`,
				});
				const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
				refs.add(result.items[0]!.source.reference);
			}
			assert.equal(refs.size, outcomes.length);
		});
	});

	describe("capture provenance", () => {
		it("collector identity is set correctly", () => {
			const event = makeEvent();
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items[0]!.capture.collector, COORDINATION_COLLECTOR_ID);
		});

		it("provenance includes family and outcome", () => {
			const event = makeEvent({
				source: { family: "interrupt", identity: "i1", reference: "ref" },
				outcome: "interrupt-handoff",
			});
			const result = collectCoordinationEvidence([event], INTERVAL, FIXED_FINGERPRINT);
			assert.ok(result.items[0]!.capture.provenance.includes("interrupt"));
			assert.ok(result.items[0]!.capture.provenance.includes("interrupt-handoff"));
		});
	});
});
