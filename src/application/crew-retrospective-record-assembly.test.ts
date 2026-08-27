import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RetrospectiveEvidence, RetrospectiveEvidenceStore } from "../domain/index.ts";
import {
	assembleRetrospectiveRecordFromStore,
	type RetrospectiveRecordAssemblyOutcome,
} from "./crew-retrospective-record-assembly.ts";

const INTERVAL = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
const NEXT_INTERVAL = { start: "2026-01-01T01:00:00.000Z", end: "2026-01-01T02:00:00.000Z" };
const RETRO = "retro-1";

function evidence(overrides: Partial<RetrospectiveEvidence> = {}): RetrospectiveEvidence {
	return {
		version: 1,
		kind: "retrospective-evidence",
		id: "coord.evt-1.member-request-response",
		interval: INTERVAL,
		source: { kind: "bebop-coordination", identity: "member-request", reference: "req-1" },
		availability: "captured",
		representation: { kind: "content", text: "gate failed twice" },
		redactions: [],
		capture: {
			capturedAt: INTERVAL.start,
			collector: "bebop.coordination-collector",
			provenance: "bebop-coordination.member-request",
		},
		fingerprint: "a".repeat(64),
		...overrides,
	} as RetrospectiveEvidence;
}

function fakeEvidenceStore(items: readonly RetrospectiveEvidence[]): RetrospectiveEvidenceStore {
	return {
		put: async () => {
			throw new Error("assembly must not write to the evidence store");
		},
		show: async () => {
			throw new Error("unused");
		},
		list: async () => [...items],
	};
}

function run(items: readonly RetrospectiveEvidence[]): Promise<RetrospectiveRecordAssemblyOutcome> {
	return assembleRetrospectiveRecordFromStore({
		retrospectiveId: RETRO,
		interval: INTERVAL,
		roster: ["Dave", "Mary"],
		collectors: [{ collector: "bebop.coordination-collector", availability: "captured" }],
		situations: [],
		evidenceStore: fakeEvidenceStore(items),
	});
}

describe("assembleRetrospectiveRecordFromStore", () => {
	it("indexes 0112 coordination, 0113 repository, and 0114 member report evidence with original provenance", async () => {
		const items = [
			evidence(),
			evidence({
				id: "repo.artifact-7",
				source: { kind: "repository-artifact", identity: "git", reference: "commit:3bdffe9" },
				fingerprint: "b".repeat(64),
				capture: {
					capturedAt: INTERVAL.start,
					collector: "bebop.repository-collector",
					provenance: "repository.git",
				},
			}),
			evidence({
				id: "member-report.retro-1.Mary.2c8c5d8e",
				source: { kind: "member-retrospective-report", identity: "Mary", reference: "req-Mary" },
				fingerprint: "c".repeat(64),
				capture: {
					capturedAt: INTERVAL.start,
					collector: "bebop.member-report-collector",
					provenance: "member-retrospective-report.retro-1.Mary",
				},
			}),
		];
		const outcome = await run(items);
		assert.equal(outcome.record.evidenceIndex.length, 3);
		const kinds = outcome.record.evidenceIndex.map((entry) => entry.sourceKind).sort();
		assert.deepEqual(kinds, ["bebop-coordination", "member-retrospective-report", "repository-artifact"]);
		const memberEntry = outcome.record.evidenceIndex.find((entry) => entry.sourceIdentity === "Mary")!;
		assert.equal(memberEntry.sourceReference, "req-Mary");
	});

	it("excludes evidence from other intervals (late evidence belongs to the next interval)", async () => {
		const late = evidence({
			id: "coord.late-1",
			interval: NEXT_INTERVAL,
			fingerprint: "d".repeat(64),
		});
		const outcome = await run([evidence(), late]);
		assert.equal(outcome.record.evidenceIndex.length, 1);
		assert.deepEqual(outcome.excludedEvidenceIds, ["coord.late-1"]);
	});

	it("preserves redaction entries and gap availability from the evidence store", async () => {
		const redacted = evidence({
			id: "member-report.retro-1.Dave.11111111",
			source: { kind: "member-retrospective-report", identity: "Dave", reference: "self-report.retro-1.Dave" },
			fingerprint: "e".repeat(64),
			representation: { kind: "content", text: "token [REDACTED:credential] in logs" },
			redactions: [{ kind: "credential", marker: "[REDACTED:credential]", occurrences: 1 }],
		});
		const gap = evidence({
			id: "coord.source-2.unavailable",
			source: { kind: "bebop-coordination", identity: "broadcast", reference: "unavailable" },
			fingerprint: "f".repeat(64),
			availability: "unavailable",
			gap: { reason: "source rotated" },
		});
		const outcome = await run([redacted, gap]);
		const gapEntry = outcome.record.evidenceIndex.find((entry) => entry.id === "coord.source-2.unavailable")!;
		assert.equal(gapEntry.availability, "unavailable");
	});

	it("is deterministic: same store contents assemble the same record hash", async () => {
		const items = [evidence()];
		const first = await run(items);
		const second = await run([evidence()]);
		assert.equal(first.record.contentHash, second.record.contentHash);
	});

	it("never writes to the evidence store (read-only)", async () => {
		await run([evidence()]);
		const store = fakeEvidenceStore([]);
		await assert.rejects(() => store.put(evidence()), /assembly must not write/);
	});
});
