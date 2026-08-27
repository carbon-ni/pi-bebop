import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRetrospectiveEvidence, type RetrospectiveEvidenceInput } from "../domain/index.ts";
import {
	openTrustedRetrospectiveEvidenceStore,
	sha256RetrospectiveEvidenceFingerprint,
} from "../infra/retrospective-evidence-store.ts";
import { openTrustedCrewRetrospectiveRecordStore } from "../infra/crew-retrospective-record-store.ts";
import { assembleRetrospectiveRecordFromStore } from "./crew-retrospective-record-assembly.ts";

const INTERVAL = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
const NEXT_INTERVAL = { start: "2026-01-01T01:00:00.000Z", end: "2026-01-01T02:00:00.000Z" };
const RETRO = "retro-1";

let projectDir: string;
let manifestPath: string;

beforeEach(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-retro-assembly-"));
	manifestPath = path.join(projectDir, ".pi", "bebop", "crew.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, "{}", "utf8");
});
afterEach(async () => fs.rm(projectDir, { recursive: true, force: true }));

function evidenceInput(overrides: Partial<RetrospectiveEvidenceInput> = {}): RetrospectiveEvidenceInput {
	return {
		id: "coord.evt-1.member-request-response",
		interval: INTERVAL,
		source: { kind: "bebop-coordination", identity: "member-request", reference: "req-1" },
		availability: "captured",
		representation: { kind: "content", text: "gate failed twice" },
		capture: {
			capturedAt: INTERVAL.start,
			collector: "bebop.coordination-collector",
			provenance: "bebop-coordination.member-request.member-request-response",
		},
		...overrides,
	};
}

describe("retrospective record assembly → freeze integration", () => {
	it("assembles from the real evidence store and freezes immutably with replay", async () => {
		const evidenceStore = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		const recordStore = await openTrustedCrewRetrospectiveRecordStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});

		await evidenceStore.put(createRetrospectiveEvidence(evidenceInput(), sha256RetrospectiveEvidenceFingerprint));
		await evidenceStore.put(
			createRetrospectiveEvidence(
				evidenceInput({
					id: "member-report.retro-1.Mary.2c8c5d8e",
					source: { kind: "member-retrospective-report", identity: "Mary", reference: "req-Mary" },
				}),
				sha256RetrospectiveEvidenceFingerprint,
			),
		);

		const outcome = await assembleRetrospectiveRecordFromStore({
			retrospectiveId: RETRO,
			interval: INTERVAL,
			roster: ["Dave", "Kelly", "Mary", "Mony"],
			collectors: [
				{ collector: "bebop.coordination-collector", availability: "captured" },
				{ collector: "bebop.repository-collector", availability: "unavailable", outcome: "git source rotated" },
				{ collector: "bebop.member-report-collector", availability: "captured" },
			],
			situations: [
				{
					id: "sit-1",
					contributors: ["Mary"],
					evidenceIds: ["member-report.retro-1.Mary.2c8c5d8e"],
					factualSummary: "Format gate blocked work for two hours",
				},
			],
			evidenceStore,
		});

		assert.equal(outcome.record.evidenceIndex.length, 2);
		assert.ok(
			outcome.record.collectors.some(
				(c) => c.availability === "unavailable" && c.outcome === "git source rotated",
			),
		);

		const freeze = await recordStore.freeze(outcome.record);
		assert.equal(freeze.alreadyFrozen, undefined);

		// Replay identical assembly: same bytes, idempotent freeze
		const replay = await assembleRetrospectiveRecordFromStore({
			retrospectiveId: RETRO,
			interval: INTERVAL,
			roster: ["Dave", "Kelly", "Mary", "Mony"],
			collectors: [
				{ collector: "bebop.coordination-collector", availability: "captured" },
				{ collector: "bebop.repository-collector", availability: "unavailable", outcome: "git source rotated" },
				{ collector: "bebop.member-report-collector", availability: "captured" },
			],
			situations: [
				{
					id: "sit-1",
					contributors: ["Mary"],
					evidenceIds: ["member-report.retro-1.Mary.2c8c5d8e"],
					factualSummary: "Format gate blocked work for two hours",
				},
			],
			evidenceStore,
		});
		assert.equal(replay.record.contentHash, outcome.record.contentHash);
		const freezeReplay = await recordStore.freeze(replay.record);
		assert.equal(freezeReplay.alreadyFrozen, true);
	});

	it("late evidence after freeze stays out of the frozen record", async () => {
		const evidenceStore = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		const recordStore = await openTrustedCrewRetrospectiveRecordStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		await evidenceStore.put(createRetrospectiveEvidence(evidenceInput(), sha256RetrospectiveEvidenceFingerprint));
		const first = await assembleRetrospectiveRecordFromStore({
			retrospectiveId: RETRO,
			interval: INTERVAL,
			roster: ["Dave"],
			collectors: [],
			situations: [],
			evidenceStore,
		});
		await recordStore.freeze(first.record);

		// Evidence arriving for the NEXT interval never touches the frozen record
		await evidenceStore.put(
			createRetrospectiveEvidence(
				evidenceInput({ id: "coord.evt-late", interval: NEXT_INTERVAL }),
				sha256RetrospectiveEvidenceFingerprint,
			),
		);
		const second = await assembleRetrospectiveRecordFromStore({
			retrospectiveId: RETRO,
			interval: INTERVAL,
			roster: ["Dave"],
			collectors: [],
			situations: [],
			evidenceStore,
		});
		assert.deepEqual(second.excludedEvidenceIds, ["coord.evt-late"]);
		assert.equal(second.record.contentHash, first.record.contentHash);
		const shown = await recordStore.show(first.record.id);
		assert.equal(shown.contentHash, first.record.contentHash);
	});

	it("every member inspects identical record identity and bytes", async () => {
		const evidenceStore = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		const recordStore = await openTrustedCrewRetrospectiveRecordStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		await evidenceStore.put(createRetrospectiveEvidence(evidenceInput(), sha256RetrospectiveEvidenceFingerprint));
		const outcome = await assembleRetrospectiveRecordFromStore({
			retrospectiveId: RETRO,
			interval: INTERVAL,
			roster: ["Dave", "Mary"],
			collectors: [],
			situations: [],
			evidenceStore,
		});
		await recordStore.freeze(outcome.record);

		const seen = ["Dave", "Mary", "Mony"].map(() => recordStore.show(outcome.record.id));
		const records = await Promise.all(seen);
		for (const record of records) {
			assert.equal(record.id, outcome.record.id);
			assert.equal(record.contentHash, outcome.record.contentHash);
		}
	});
});
