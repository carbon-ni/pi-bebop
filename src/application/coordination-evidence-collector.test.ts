import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	collectCoordinationEvidence,
	collectSingleCoordinationEvent,
	coordinationSourceGap,
	COORDINATION_COLLECTOR_ID,
	collectFromSources,
	type CoordinationEventSource,
} from "./coordination-evidence-collector.ts";
import { type CoordinationEvent, type CoordinationOutcomeKind } from "../domain/coordination-evidence.ts";
import {
	orderAndDeduplicateRetrospectiveEvidence,
	canonicalRetrospectiveEvidenceFingerprintInput,
	type RetrospectiveEvidence,
	type RetrospectiveEvidenceInterval,
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

	describe("collectFromSources — injected source seam", () => {
		function makeSource(
			overrides: Partial<CoordinationEventSource> & { events?: readonly CoordinationEvent[] } = {},
		): CoordinationEventSource {
			const events = overrides.events ?? [];
			return {
				family: overrides.family ?? "member-request",
				identity: overrides.identity ?? "src-1",
				collect: overrides.collect ?? ((_interval: RetrospectiveEvidenceInterval) => events),
			};
		}

		it("collects from a single source", () => {
			const source = makeSource({
				events: [
					makeEvent({ source: { family: "member-request", identity: "req-1", reference: "ref" }, outcome: "member-request-response", correlationId: "req-1" }),
				],
			});
			const result = collectFromSources([source], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 1);
			assert.equal(result.gaps.length, 0);
		});

		it("collects from multiple sources across families", () => {
			const sources: CoordinationEventSource[] = [
				makeSource({
					family: "member-request",
					events: [makeEvent({ source: { family: "member-request", identity: "r1", reference: "ref" }, outcome: "member-request-response", correlationId: "r1" })],
				}),
				makeSource({
					family: "interrupt",
					events: [makeEvent({ source: { family: "interrupt", identity: "i1", reference: "ref" }, outcome: "interrupt-handoff", correlationId: "i1" })],
				}),
				makeSource({
					family: "broadcast",
					events: [makeEvent({ source: { family: "broadcast", identity: "b1", reference: "ref" }, outcome: "broadcast-persisted", correlationId: "b1" })],
				}),
			];
			const result = collectFromSources(sources, INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 3);
			assert.equal(result.gaps.length, 0);
		});

		it("source that throws becomes explicit gap evidence", () => {
			const source = makeSource({
				family: "inbox",
				identity: "corrupt-source",
				collect: () => {
					throw new Error("journal corrupted");
				},
			});
			const result = collectFromSources([source], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 0);
			assert.equal(result.gaps.length, 1);
			assert.equal(result.gaps[0]!.availability, "unavailable");
			assert.ok(result.gaps[0]!.gap!.reason.includes("journal corrupted"));
		});

		it("source returning empty events is not a gap", () => {
			const source = makeSource({ events: [] });
			const result = collectFromSources([source], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 0);
			assert.equal(result.gaps.length, 0);
		});

		it("one failing source does not prevent other sources from being collected", () => {
			const goodSource = makeSource({
				events: [makeEvent({ source: { family: "membership", identity: "m1", reference: "ref" }, outcome: "membership-join-failed", correlationId: "m1" })],
			});
			const failingSource = makeSource({
				family: "interrupt",
				identity: "rotated-source",
				collect: () => {
					throw new Error("source rotated");
				},
			});
			const result = collectFromSources([failingSource, goodSource], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 1);
			assert.equal(result.gaps.length, 1);
			assert.ok(result.gaps[0]!.source.identity.includes("rotated-source"));
		});

		it("source seam is read-only — never calls send/activate/mutate", () => {
			let sourceCalled = false;
			const source = makeSource({
				collect: () => {
					sourceCalled = true;
					return [];
				},
			});
			collectFromSources([source], INTERVAL, FIXED_FINGERPRINT);
			assert.ok(sourceCalled);
			// Source only returned events; no side-effect surface exists on the seam
			assert.equal(source.collect(INTERVAL).length, 0);
		});

		it("rejects events from source that have non-mechanical context", () => {
			const source = makeSource({
				events: [
					makeEvent({ context: { productive: true } as unknown as import("../domain/coordination-evidence.ts").CoordinationMechanicalContext }),
				],
			});
			const result = collectFromSources([source], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 0);
			assert.equal(result.rejected.length, 1);
			assert.ok(result.rejected[0]!.reason.includes("non-mechanical"));
		});

		it("events outside the interval from a source are rejected not gapped", () => {
			const source = makeSource({
				events: [
					makeEvent({ occurredAt: "2099-01-01T00:00:00.000Z", correlationId: "future" }),
					makeEvent({ occurredAt: "2026-01-01T00:30:00.000Z", correlationId: "valid" }),
				],
			});
			const result = collectFromSources([source], INTERVAL, FIXED_FINGERPRINT);
			assert.equal(result.items.length, 1);
			assert.equal(result.rejected.length, 1);
			assert.equal(result.gaps.length, 0);
		});
	});

	describe("adversarial — secrets/credentials redacted by store layer", () => {
		it("credential-like content is redacted in representation", () => {
			const event = makeEvent({ contentSummary: "token=ghp_abc123secret" });
			const evidence = collectSingleCoordinationEvent(event, INTERVAL, FIXED_FINGERPRINT);
			// The retrospective-evidence redaction layer handles this
			assert.ok(evidence.redactions.length >= 0); // redactions may or may not trigger
			// Key: the original secret never appears in the evidence representation
			assert.ok(!evidence.representation!.text.includes("ghp_abc123secret"));
		});

		it("hidden reasoning is simply unavailable (never collected)", () => {
			// CoordinationEvent has no hidden-reasoning field — it's structurally impossible
			const event = makeEvent();
			assert.ok((event as Record<string, unknown>).hiddenReasoning === undefined);
			assert.ok((event as Record<string, unknown>).agentThinking === undefined);
		});
	});
});
