import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CrewRetrospectiveRecordStoreError,
	openTrustedCrewRetrospectiveRecordStore,
} from "./crew-retrospective-record-store.ts";
import type { CrewRetrospectiveRecord } from "../domain/retrospective-record.ts";

function record(id: string, extra: Partial<CrewRetrospectiveRecord> = {}): CrewRetrospectiveRecord {
	return {
		version: 1,
		kind: "crew-retrospective-record",
		id,
		retrospectiveId: "retro-1",
		interval: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" },
		roster: ["Dave"],
		collectors: [],
		evidenceIndex: [],
		omittedEvidenceCount: 0,
		situations: [],
		omittedSituationCount: 0,
		contentHash: "a".repeat(64),
		...extra,
	};
}

async function withStore(
	run: (store: Awaited<ReturnType<typeof openTrustedCrewRetrospectiveRecordStore>>) => Promise<void>,
) {
	const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-retro-record-"));
	const manifestPath = path.join(projectDir, ".pi", "bebop", "crew.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, "{}", "utf8");
	try {
		const store = await openTrustedCrewRetrospectiveRecordStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		await run(store);
	} finally {
		await fs.rm(projectDir, { recursive: true, force: true });
	}
}

describe("crew retrospective record store", () => {
	it("freezes a record once and returns it identically on replay", async () => {
		await withStore(async (store) => {
			const frozen = record("retro-record.retro-1.00000001");
			const first = await store.freeze(frozen);
			assert.equal(first.alreadyFrozen, undefined);
			const second = await store.freeze(frozen);
			assert.equal(second.alreadyFrozen, true);
			assert.equal(second.record.contentHash, frozen.contentHash);
		});
	});

	it("rejects conflicting bytes for a frozen record id", async () => {
		await withStore(async (store) => {
			await store.freeze(record("retro-record.retro-1.00000001"));
			const conflicting = record("retro-record.retro-1.00000001", { contentHash: "b".repeat(64) });
			await assert.rejects(() => store.freeze(conflicting), /frozen with different bytes/);
		});
	});

	it("shows the exact frozen bytes", async () => {
		await withStore(async (store) => {
			const frozen = record("retro-record.retro-1.00000002", { omittedEvidenceCount: 5 });
			await store.freeze(frozen);
			const shown = await store.show(frozen.id);
			assert.equal(shown.contentHash, frozen.contentHash);
			assert.equal(shown.omittedEvidenceCount, 5);
		});
	});

	it("lists frozen records deterministically", async () => {
		await withStore(async (store) => {
			await store.freeze(record("retro-record.retro-1.00000003"));
			await store.freeze(record("retro-record.retro-1.00000004"));
			const listed = await store.list();
			assert.deepEqual(
				listed.map((item) => item.id),
				["retro-record.retro-1.00000003", "retro-record.retro-1.00000004"],
			);
		});
	});

	it("rejects path-unsafe record ids", async () => {
		await withStore(async (store) => {
			await assert.rejects(() => store.freeze(record("../../escape")), /safe/i);
		});
	});

	it("show on unknown id fails explicitly", async () => {
		await withStore(async (store) => {
			await assert.rejects(() => store.show("retro-record.retro-1.ffffffff"), CrewRetrospectiveRecordStoreError);
		});
	});

	it("rejects records that are not crew retrospective records", async () => {
		await withStore(async (store) => {
			await assert.rejects(
				() => store.freeze({ version: 99 } as unknown as CrewRetrospectiveRecord),
				/not a crew retrospective record/,
			);
		});
	});

	it("rejects untrusted projects", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-retro-record-untrusted-"));
		const manifestPath = path.join(projectDir, ".pi", "bebop", "crew.json");
		await fs.mkdir(path.dirname(manifestPath), { recursive: true });
		await fs.writeFile(manifestPath, "{}", "utf8");
		try {
			await assert.rejects(
				() =>
					openTrustedCrewRetrospectiveRecordStore({
						projectRoot: projectDir,
						manifestPath,
						isProjectTrusted: () => false,
					}),
				/untrusted project/i,
			);
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});
});
