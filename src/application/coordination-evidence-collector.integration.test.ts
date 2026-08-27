import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectFromSources, type CoordinationEventSource } from "./coordination-evidence-collector.ts";
import { type CoordinationEvent } from "../domain/coordination-evidence.ts";
import {
	openTrustedRetrospectiveEvidenceStore,
	sha256RetrospectiveEvidenceFingerprint,
} from "../infra/retrospective-evidence-store.ts";
import { orderAndDeduplicateRetrospectiveEvidence } from "../domain/index.ts";

const INTERVAL = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };

function makeEvent(overrides: Partial<CoordinationEvent> = {}): CoordinationEvent {
	return {
		source: { family: "member-request", identity: "req-1", reference: "ref" },
		outcome: "member-request-response",
		occurredAt: "2026-01-01T00:30:00.000Z",
		...overrides,
	};
}

let projectDir: string;
let manifestPath: string;

beforeEach(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-coordination-evidence-"));
	manifestPath = path.join(projectDir, ".pi", "bebop", "crew.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, "{}", "utf8");
});

afterEach(async () => fs.rm(projectDir, { recursive: true, force: true }));

describe("coordination evidence collector → store integration", () => {
	it("collects events from sources and persists via store with dedup", async () => {
		const store = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});

		const sources: CoordinationEventSource[] = [
			{
				family: "member-request",
				identity: "member-request-source",
				collect: () => [
					makeEvent({
						source: { family: "member-request", identity: "req-1", reference: "ref" },
						outcome: "member-request-response",
						correlationId: "req-1",
					}),
					makeEvent({
						source: { family: "member-request", identity: "req-2", reference: "ref" },
						outcome: "member-request-offline",
						correlationId: "req-2",
					}),
				],
			},
			{
				family: "interrupt",
				identity: "interrupt-source",
				collect: () => [
					makeEvent({
						source: { family: "interrupt", identity: "int-1", reference: "ref" },
						outcome: "interrupt-handoff",
						correlationId: "int-1",
					}),
				],
			},
		];

		const result = collectFromSources(sources, INTERVAL, sha256RetrospectiveEvidenceFingerprint);
		assert.equal(result.items.length, 3);
		assert.equal(result.gaps.length, 0);

		// First persist: new records, no alreadyPersisted flag
		for (const item of result.items) {
			const putResult = await store.put(item);
			assert.equal(putResult.alreadyPersisted, undefined);
			assert.equal(putResult.record.id, item.id);
		}

		// Replay same collection — byte-identical evidence, store dedups by id+fingerprint
		const result2 = collectFromSources(sources, INTERVAL, sha256RetrospectiveEvidenceFingerprint);
		for (const item of result2.items) {
			const putResult = await store.put(item);
			assert.equal(putResult.alreadyPersisted, true);
		}

		// List and verify
		const listed = await store.list();
		assert.equal(listed.length, 3);

		// Verify ordering and dedup at the store query level
		const deduped = orderAndDeduplicateRetrospectiveEvidence(listed);
		assert.equal(deduped.length, 3);
	});

	it("gap evidence from corrupt source persists correctly", async () => {
		const store = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});

		const failingSource: CoordinationEventSource = {
			family: "membership",
			identity: "corrupt-membership",
			collect: () => {
				throw new Error("membership journal corrupted");
			},
		};

		const result = collectFromSources([failingSource], INTERVAL, sha256RetrospectiveEvidenceFingerprint);
		assert.equal(result.items.length, 0);
		assert.equal(result.gaps.length, 1);

		const putResult = await store.put(result.gaps[0]!);
		assert.equal(putResult.alreadyPersisted, undefined);

		// Replaying the same failing source yields a byte-identical gap → idempotent
		const result2 = collectFromSources([failingSource], INTERVAL, sha256RetrospectiveEvidenceFingerprint);
		const putResult2 = await store.put(result2.gaps[0]!);
		assert.equal(putResult2.alreadyPersisted, true);

		const listed = await store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0]!.availability, "unavailable");
		assert.ok(listed[0]!.gap!.reason.includes("membership journal corrupted"));
	});

	it("zero messaging/Inbox/Agreement side effects — store is evidence-only", async () => {
		const store = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});

		const source: CoordinationEventSource = {
			family: "broadcast",
			identity: "bc-1",
			collect: () => [
				makeEvent({
					source: { family: "broadcast", identity: "bc-1", reference: "ref" },
					outcome: "broadcast-persisted",
					correlationId: "bc-1",
					memberId: "Mary",
					targetMemberId: "Dave",
					contentSummary: "task update",
				}),
			],
		};

		const result = collectFromSources([source], INTERVAL, sha256RetrospectiveEvidenceFingerprint);
		assert.equal(result.items.length, 1);

		// Store put is evidence-only — verify the evidence has no messaging metadata
		const evidence = result.items[0]!;
		assert.equal(evidence.kind, "retrospective-evidence");
		assert.equal(evidence.source.kind, "bebop-coordination");
		assert.equal(evidence.availability, "captured");

		// Persist and re-read
		await store.put(evidence);
		const listed = await store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0]!.fingerprint, evidence.fingerprint);
	});
});
