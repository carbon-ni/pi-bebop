import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CREW_RETROSPECTIVE_RECORD_VERSION,
	MAX_RECORD_EVIDENCE_INDEX_ENTRIES,
	MAX_RECORD_SITUATIONS,
	MAX_SITUATION_SUMMARY_BYTES,
	assembleCrewRetrospectiveRecord,
	canonicalRetrospectiveRecordJson,
	retrospectiveRecordContentHash,
	retrospectiveRecordId,
	isCrewRetrospectiveRecord,
	type RetrospectiveSituationInput,
	type RecordEvidenceItem,
	type CollectorSnapshotEntry,
	type AssemblyInput,
} from "./retrospective-record.ts";

const INTERVAL = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
const RETRO = "retro-1";
const ROSTER = ["Dave", "Kelly", "Mary", "Mony"];

function evidenceItem(overrides: Partial<RecordEvidenceItem> = {}): RecordEvidenceItem {
	return {
		id: "coord.evt-1.response",
		fingerprint: "a".repeat(64),
		canonicalBytes: JSON.stringify({ id: "coord.evt-1.response", payload: "gate failed twice" }),
		sourceKind: "bebop-coordination",
		sourceIdentity: "member-request",
		sourceReference: "req-1",
		availability: "captured",
		...overrides,
	};
}

function situation(overrides: Partial<RetrospectiveSituationInput> = {}): RetrospectiveSituationInput {
	return {
		id: "sit-1",
		contributors: ["Dave"],
		evidenceIds: ["coord.evt-1.response"],
		factualSummary: "Release gate failed twice on format checks",
		interpretation: undefined,
		agreementRefs: undefined,
		disputeWith: undefined,
		...overrides,
	};
}

function collectors(overrides: CollectorSnapshotEntry[] = []): readonly CollectorSnapshotEntry[] {
	return [
		{ collector: "bebop.coordination-collector", availability: "captured" },
		{ collector: "bebop.repository-collector", availability: "captured" },
		{ collector: "bebop.member-report-collector", availability: "captured" },
		...overrides,
	];
}

function assemblyInput(overrides: Partial<AssemblyInput> = {}): AssemblyInput {
	return {
		retrospectiveId: RETRO,
		interval: INTERVAL,
		roster: ROSTER,
		collectors: collectors(),
		evidence: [evidenceItem()],
		situations: [situation()],
		...overrides,
	};
}

describe("record identity", () => {
	it("derives a stable, path-safe record id from retrospective and interval", () => {
		const id = retrospectiveRecordId(RETRO, INTERVAL);
		assert.equal(id, retrospectiveRecordId(RETRO, INTERVAL));
		assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
	});

	it("different interval changes the id", () => {
		const other = { start: "2026-01-02T00:00:00.000Z", end: "2026-01-02T01:00:00.000Z" };
		assert.notEqual(retrospectiveRecordId(RETRO, INTERVAL), retrospectiveRecordId(RETRO, other));
	});
});

describe("deterministic assembly", () => {
	it("identical inputs produce byte-identical records and hashes", () => {
		const a = assembleCrewRetrospectiveRecord(assemblyInput());
		const b = assembleCrewRetrospectiveRecord(assemblyInput());
		assert.equal(canonicalRetrospectiveRecordJson(a), canonicalRetrospectiveRecordJson(b));
		assert.equal(a.contentHash, b.contentHash);
		assert.equal(a.id, b.id);
	});

	it("reversed evidence order produces identical record (deterministic ordering)", () => {
		const items = [
			evidenceItem({ id: "a.1", fingerprint: "b".repeat(64) }),
			evidenceItem({ id: "b.2", fingerprint: "a".repeat(64) }),
			evidenceItem({ id: "c.3", fingerprint: "c".repeat(64), sourceKind: "member-retrospective-report" }),
		];
		const situations = [situation({ evidenceIds: ["a.1"] })];
		const forward = assembleCrewRetrospectiveRecord(assemblyInput({ evidence: items, situations }));
		const reversed = assembleCrewRetrospectiveRecord({
			...assemblyInput(),
			evidence: [...items].reverse(),
			situations,
		});
		assert.equal(forward.contentHash, reversed.contentHash);
		assert.deepEqual(
			forward.evidenceIndex.map((e) => e.id),
			reversed.evidenceIndex.map((e) => e.id),
		);
	});

	it("differing evidence changes the content hash", () => {
		const base = assembleCrewRetrospectiveRecord(assemblyInput());
		const changed = assembleCrewRetrospectiveRecord(
			assemblyInput({
				evidence: [evidenceItem({ canonicalBytes: JSON.stringify({ different: true }) })],
			}),
		);
		assert.notEqual(base.contentHash, changed.contentHash);
	});

	it("differing situation summary changes the content hash", () => {
		const base = assembleCrewRetrospectiveRecord(assemblyInput());
		const changed = assembleCrewRetrospectiveRecord(
			assemblyInput({ situations: [situation({ factualSummary: "different summary" })] }),
		);
		assert.notEqual(base.contentHash, changed.contentHash);
	});

	it("content hash matches exported hash function over pre-hash canonical bytes", () => {
		const record = assembleCrewRetrospectiveRecord(assemblyInput());
		const { contentHash: _hash, ...withoutHash } = record;
		void _hash;
		assert.equal(retrospectiveRecordContentHash(withoutHash), record.contentHash);
	});
});

describe("evidence index: dedup, conflict, provenance", () => {
	it("identical fingerprint and canonical bytes dedup with linked provenance identities", () => {
		const same = evidenceItem();
		const duplicateSource = evidenceItem({
			id: "coord.evt-1.response",
			sourceIdentity: "member-request",
			sourceKind: "bebop-coordination",
			canonicalBytes: same.canonicalBytes,
			fingerprint: same.fingerprint,
		});
		const record = assembleCrewRetrospectiveRecord(assemblyInput({ evidence: [same, duplicateSource] }));
		assert.equal(record.evidenceIndex.length, 1);
	});

	it("same fingerprint with different canonical bytes is an explicit conflict, both retained", () => {
		const a = evidenceItem({ fingerprint: "d".repeat(64), canonicalBytes: JSON.stringify({ v: 1 }) });
		const b = evidenceItem({
			id: "repo.artifact-2",
			fingerprint: "d".repeat(64),
			canonicalBytes: JSON.stringify({ v: 2 }),
		});
		const record = assembleCrewRetrospectiveRecord(assemblyInput({ evidence: [a, b] }));
		const conflicts = record.evidenceIndex.filter((entry) => entry.conflict);
		assert.equal(conflicts.length, 2, "both conflicting entries retained and flagged");
	});

	it("unavailable evidence keeps gap visibility in the index", () => {
		const gap = evidenceItem({
			id: "coord.source-1.unavailable",
			fingerprint: "e".repeat(64),
			availability: "unavailable",
		});
		const record = assembleCrewRetrospectiveRecord(
			assemblyInput({ evidence: [evidenceItem(), gap], situations: [situation()] }),
		);
		const gapEntries = record.evidenceIndex.filter((entry) => entry.availability === "unavailable");
		assert.equal(gapEntries.length, 1);
	});
});

describe("collector snapshot gaps", () => {
	it("unavailable collector is visible, never inferred no-work", () => {
		const record = assembleCrewRetrospectiveRecord(
			assemblyInput({
				collectors: [
					{
						collector: "bebop.coordination-collector",
						availability: "unavailable",
						outcome: "source rotated",
					},
				],
			}),
		);
		assert.equal(record.collectors[0]!.availability, "unavailable");
		assert.ok(record.collectors[0]!.outcome!.includes("source rotated"));
	});

	it("missing member report states remain visible", () => {
		const record = assembleCrewRetrospectiveRecord(
			assemblyInput({
				collectors: [
					{
						collector: "bebop.member-report-collector",
						availability: "unavailable",
						outcome: "Dave offline",
					},
				],
			}),
		);
		assert.equal(record.collectors.length, 1);
	});
});

describe("situation validation", () => {
	it("rejects a situation without evidence references", () => {
		assert.throws(
			() => assembleCrewRetrospectiveRecord(assemblyInput({ situations: [situation({ evidenceIds: [] })] })),
			/evidence/,
		);
	});

	it("rejects a situation referencing evidence not in the index", () => {
		assert.throws(
			() =>
				assembleCrewRetrospectiveRecord(
					assemblyInput({ situations: [situation({ evidenceIds: ["missing.evidence"] })] }),
				),
			/evidence/,
		);
	});

	it("rejects situation summary exceeding byte bound", () => {
		assert.throws(
			() =>
				assembleCrewRetrospectiveRecord(
					assemblyInput({
						situations: [situation({ factualSummary: "x".repeat(MAX_SITUATION_SUMMARY_BYTES + 1) })],
					}),
				),
			/summary/,
		);
	});

	it("separately labels interpretation with producer and nondeterminism", () => {
		const record = assembleCrewRetrospectiveRecord(
			assemblyInput({
				situations: [
					situation({
						interpretation: {
							text: "Gate failures likely stem from format drift",
							producer: "Mony",
							producerVersion: "claude-opus-4.6",
							nondeterminism: "model",
						},
					}),
				],
			}),
		);
		const interpretation = record.situations[0]!.interpretation!;
		assert.equal(interpretation.nondeterminism, "model");
		assert.equal(interpretation.producer, "Mony");
		assert.notEqual(interpretation.text, record.situations[0]!.factualSummary);
	});

	it("keeps conflicting accounts side-by-side via dispute links", () => {
		const record = assembleCrewRetrospectiveRecord(
			assemblyInput({
				situations: [
					situation({ id: "sit-a", contributors: ["Dave"] }),
					situation({ id: "sit-b", contributors: ["Mary"], disputeWith: ["sit-a"] }),
				],
			}),
		);
		assert.equal(record.situations.length, 2);
		assert.deepEqual(record.situations[1]!.disputeWith, ["sit-a"]);
	});

	it("rejects dispute links to nonexistent situations", () => {
		assert.throws(
			() =>
				assembleCrewRetrospectiveRecord(assemblyInput({ situations: [situation({ disputeWith: ["ghost"] })] })),
			/dispute/,
		);
	});

	it("carries current/trial agreement references without activating anything", () => {
		const record = assembleCrewRetrospectiveRecord(
			assemblyInput({ situations: [situation({ agreementRefs: ["agree.fmt-check.3"] })] }),
		);
		assert.deepEqual(record.situations[0]!.agreementRefs, ["agree.fmt-check.3"]);
	});

	it("rejects duplicate situation ids", () => {
		assert.throws(
			() =>
				assembleCrewRetrospectiveRecord(
					assemblyInput({
						situations: [situation({ id: "dup" }), situation({ id: "dup", contributors: ["Mary"] })],
					}),
				),
			/duplicate situation/i,
		);
	});
});

describe("overflow handling", () => {
	it("caps evidence index with explicit omitted count", () => {
		const many = Array.from({ length: MAX_RECORD_EVIDENCE_INDEX_ENTRIES + 7 }, (_, i) =>
			evidenceItem({ id: `e.${String(i).padStart(4, "0")}`, fingerprint: `${String(i).padStart(64, "0")}` }),
		);
		const record = assembleCrewRetrospectiveRecord(assemblyInput({ evidence: many, situations: [] }));
		assert.equal(record.evidenceIndex.length, MAX_RECORD_EVIDENCE_INDEX_ENTRIES);
		assert.equal(record.omittedEvidenceCount, 7);
	});

	it("caps situations with explicit omitted count", () => {
		const many = Array.from({ length: MAX_RECORD_SITUATIONS + 3 }, (_, i) =>
			situation({ id: `s.${String(i).padStart(3, "0")}` }),
		);
		const record = assembleCrewRetrospectiveRecord(assemblyInput({ situations: many }));
		assert.equal(record.situations.length, MAX_RECORD_SITUATIONS);
		assert.equal(record.omittedSituationCount, 3);
	});

	it("overflow keeps a deterministic sorted subset", () => {
		const many = Array.from({ length: MAX_RECORD_SITUATIONS + 1 }, (_, i) =>
			situation({ id: `s.${String(i).padStart(3, "0")}` }),
		);
		const a = assembleCrewRetrospectiveRecord(assemblyInput({ situations: many }));
		const b = assembleCrewRetrospectiveRecord(assemblyInput({ situations: [...many].reverse() }));
		assert.deepEqual(
			a.situations.map((s) => s.id),
			b.situations.map((s) => s.id),
		);
	});
});

describe("redaction preservation", () => {
	it("keeps redaction markers in summaries; secrets never enter the record", () => {
		const record = assembleCrewRetrospectiveRecord(
			assemblyInput({
				situations: [situation({ factualSummary: "token [REDACTED:credential] leaked in logs" })],
			}),
		);
		assert.ok(record.situations[0]!.factualSummary.includes("[REDACTED:credential]"));
		assert.throws(
			() =>
				assembleCrewRetrospectiveRecord(
					assemblyInput({
						situations: [situation({ factualSummary: "token=ghp_rawsecretvalue in logs" })],
					}),
				),
			/credential/i,
		);
	});
});

describe("structural guard", () => {
	it("isCrewRetrospectiveRecord accepts assembled records", () => {
		const record = assembleCrewRetrospectiveRecord(assemblyInput());
		assert.equal(isCrewRetrospectiveRecord(record), true);
	});

	it("rejects foreign objects", () => {
		assert.equal(isCrewRetrospectiveRecord(null), false);
		assert.equal(isCrewRetrospectiveRecord({ version: 99 }), false);
	});
});

describe("input validation", () => {
	it("rejects empty roster", () => {
		assert.throws(() => assembleCrewRetrospectiveRecord(assemblyInput({ roster: [] })), /roster/);
	});

	it("rejects invalid interval (end before start)", () => {
		assert.throws(
			() =>
				assembleCrewRetrospectiveRecord(
					assemblyInput({ interval: { start: INTERVAL.end, end: INTERVAL.start } }),
				),
			/interval/,
		);
	});

	it("preserves manifest roster order", () => {
		const record = assembleCrewRetrospectiveRecord(assemblyInput({ roster: ["Zed", "Amy"] }));
		assert.deepEqual(record.roster, ["Zed", "Amy"]);
	});
});

describe("version constant", () => {
	it("record carries version 1", () => {
		const record = assembleCrewRetrospectiveRecord(assemblyInput());
		assert.equal(record.version, CREW_RETROSPECTIVE_RECORD_VERSION);
		assert.equal(record.kind, "crew-retrospective-record");
	});
});
