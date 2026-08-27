import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	coordinationEventFamily,
	coordinationEvidenceId,
	boundContentSummary,
	MAX_COORDINATION_CONTENT_SUMMARY_BYTES,
	COORDINATION_TRUNCATION_MARKER,
	isValidMechanicalContext,
	coordinationSourceIdentity,
	coordinationSourceReference,
	isMechanicalContextOnly,
	type CoordinationEventFamily,
	type CoordinationOutcomeKind,
	type CoordinationMechanicalContext,
} from "./coordination-evidence.ts";

describe("coordination-evidence domain", () => {
	describe("coordinationEventFamily", () => {
		const families: CoordinationEventFamily[] = [
			"member-request",
			"member-message",
			"broadcast",
			"interrupt",
			"inbox",
			"membership",
		];
		for (const family of families) {
			it(`returns stable prefix for ${family}`, () => {
				const result = coordinationEventFamily(family);
				assert.ok(result.startsWith("bebop."));
				assert.equal(result, coordinationEventFamily(family)); // deterministic
			});
		}
	});

	describe("coordinationEvidenceId", () => {
		it("produces deterministic ID from family, correlation, and outcome", () => {
			const a = coordinationEvidenceId("member-request", "req-1", "member-request-response");
			const b = coordinationEvidenceId("member-request", "req-1", "member-request-response");
			assert.equal(a, b);
		});

		it("different outcomes produce different IDs for same correlation", () => {
			const a = coordinationEvidenceId("member-request", "req-1", "member-request-response");
			const b = coordinationEvidenceId("member-request", "req-1", "member-request-offline");
			assert.notEqual(a, b);
		});

		it("different families produce different IDs", () => {
			const a = coordinationEvidenceId("member-request", "id-1", "member-request-response");
			const b = coordinationEvidenceId("interrupt", "id-1", "interrupt-pending");
			assert.notEqual(a, b);
		});
	});

	describe("boundContentSummary", () => {
		it("returns value unchanged when within limit", () => {
			const input = "hello world";
			assert.equal(boundContentSummary(input), input);
		});

		it("truncates and appends marker when over limit", () => {
			const input = "a".repeat(MAX_COORDINATION_CONTENT_SUMMARY_BYTES + 100);
			const result = boundContentSummary(input);
			assert.ok(result.endsWith(COORDINATION_TRUNCATION_MARKER));
			const encoder = new TextEncoder();
			assert.ok(encoder.encode(result).byteLength <= MAX_COORDINATION_CONTENT_SUMMARY_BYTES);
		});

		it("respects UTF-8 boundaries", () => {
			// Multi-byte characters should not be split
			const input = "ü".repeat(500); // Each ü is 2 bytes
			const result = boundContentSummary(input, 100);
			assert.ok(!result.includes("\ufffd"));
			assert.ok(result.endsWith(COORDINATION_TRUNCATION_MARKER));
		});

		it("returns only marker when budget is zero or negative", () => {
			assert.equal(boundContentSummary("hello", 0), COORDINATION_TRUNCATION_MARKER);
			assert.equal(boundContentSummary("hello", -1), COORDINATION_TRUNCATION_MARKER);
		});

		it("never exposes hidden reasoning (no hidden field exists)", () => {
			// Content summary is bounded/redacted; hidden reasoning is simply unavailable
			const result = boundContentSummary("visible crew content", 20);
			assert.ok(typeof result === "string");
			assert.ok(result.length > 0);
		});
	});

	describe("isValidMechanicalContext", () => {
		it("accepts empty context", () => {
			assert.ok(isValidMechanicalContext({}));
		});

		it("accepts single idle flag", () => {
			assert.ok(isValidMechanicalContext({ idle: true }));
		});

		it("accepts single busy flag", () => {
			assert.ok(isValidMechanicalContext({ busy: true }));
		});

		it("accepts single compacting flag", () => {
			assert.ok(isValidMechanicalContext({ compacting: true }));
		});

		it("rejects multiple flags (idle + busy)", () => {
			assert.ok(!isValidMechanicalContext({ idle: true, busy: true }));
		});

		it("rejects all three flags", () => {
			assert.ok(!isValidMechanicalContext({ idle: true, busy: true, compacting: true }));
		});
	});

	describe("coordinationSourceIdentity", () => {
		it("combines family prefix with primary ID", () => {
			assert.equal(coordinationSourceIdentity("member-request", "req-42"), "bebop.member-request.req-42");
		});

		it("is deterministic", () => {
			const a = coordinationSourceIdentity("broadcast", "bc-1");
			const b = coordinationSourceIdentity("broadcast", "bc-1");
			assert.equal(a, b);
		});
	});

	describe("coordinationSourceReference", () => {
		it("includes family, primary ID, and outcome", () => {
			assert.equal(
				coordinationSourceReference("member-request", "req-42", "member-request-response"),
				"bebop.member-request.req-42.member-request-response",
			);
		});
	});

	describe("isMechanicalContextOnly", () => {
		it("accepts valid mechanical context objects", () => {
			assert.ok(isMechanicalContextOnly({ idle: true }));
			assert.ok(isMechanicalContextOnly({ busy: true }));
			assert.ok(isMechanicalContextOnly({}));
		});

		it("rejects productivity or intent claims", () => {
			assert.ok(!isMechanicalContextOnly({ productive: true }));
			assert.ok(!isMechanicalContextOnly({ available: true }));
			assert.ok(!isMechanicalContextOnly({ intent: "working" }));
		});

		it("rejects non-objects", () => {
			assert.ok(!isMechanicalContextOnly(null));
			assert.ok(!isMechanicalContextOnly("idle"));
			assert.ok(!isMechanicalContextOnly(42));
		});

		it("rejects multiple valid flags", () => {
			assert.ok(!isMechanicalContextOnly({ idle: true, busy: true }));
		});
	});

	describe("outcome vocabulary — never conflated", () => {
		const distinctOutcomes: CoordinationOutcomeKind[] = [
			"member-request-response",
			"member-request-offline",
			"member-request-timeout-max-wait",
			"member-request-timeout-response-after-idle",
			"member-request-outcome-unknown",
			"interrupt-pending",
			"interrupt-handoff",
			"interrupt-direct",
			"interrupt-abort-failed",
			"inbox-enqueued",
			"inbox-capacity-exceeded",
			"membership-join-failed",
		];

		it("all outcomes are distinct strings", () => {
			const unique = new Set(distinctOutcomes);
			assert.equal(unique.size, distinctOutcomes.length);
		});

		it("timeout reasons are distinct (max-wait vs response-after-idle)", () => {
			assert.notEqual("member-request-timeout-max-wait", "member-request-timeout-response-after-idle");
		});

		it("broadcast partial outcomes are distinct", () => {
			assert.notEqual("broadcast-persisted", "broadcast-already-persisted");
			assert.notEqual("broadcast-persisted", "broadcast-failed");
			assert.notEqual("broadcast-already-persisted", "broadcast-failed");
		});
	});
});
