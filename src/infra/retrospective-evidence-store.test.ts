import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
	createRetrospectiveEvidence,
	type RetrospectiveEvidence,
	type RetrospectiveEvidenceInput,
} from "../domain/index.ts";
import {
	MAX_RETROSPECTIVE_EVIDENCE_FILE_BYTES,
	MAX_RETROSPECTIVE_EVIDENCE_RECORDS,
	RetrospectiveEvidenceStoreError,
	openTrustedRetrospectiveEvidenceStore,
	sha256RetrospectiveEvidenceFingerprint,
} from "./retrospective-evidence-store.ts";

let projectDir: string;
let manifestPath: string;

beforeEach(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-retrospective-evidence-"));
	manifestPath = path.join(projectDir, ".pi", "bebop", "crew.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, "{}", "utf8");
});
afterEach(async () => fs.rm(projectDir, { recursive: true, force: true }));

function input(id: string): RetrospectiveEvidenceInput {
	return {
		id,
		interval: { start: "2026-08-27T09:00:00.000Z", end: "2026-08-27T10:00:00.000Z" },
		source: { kind: "bebop-coordination", identity: "request:req-1", reference: "event:event-1" },
		availability: "captured",
		representation: { kind: "summary", text: "Follow-up was accepted by Kelly." },
		capture: {
			capturedAt: "2026-08-27T10:01:00.000Z",
			collector: "bebop-coordination-v1",
			provenance: "typed-message:event-1",
		},
	};
}
function evidence(id: string): RetrospectiveEvidence {
	return createRetrospectiveEvidence(input(id), sha256RetrospectiveEvidenceFingerprint);
}
async function openStore() {
	return await openTrustedRetrospectiveEvidenceStore({
		manifestPath,
		projectRoot: projectDir,
		isProjectTrusted: () => true,
	});
}
function recordsDirectory(): string {
	return path.join(projectDir, ".pi", "bebop", "retrospectives", "evidence", "records");
}

test("persists atomically, restarts, lists stably, and replays the same immutable record", async () => {
	const store = await openStore();
	const saved = await store.put(evidence("event-b"));
	assert.equal(saved.record.id, "event-b");
	assert.equal(saved.alreadyPersisted, undefined);
	assert.equal((await store.put(evidence("event-b"))).alreadyPersisted, true);
	await store.put(
		createRetrospectiveEvidence(
			{
				...input("event-a"),
				source: { kind: "repository-artifact", identity: "commit:abc", reference: "git:abc" },
			},
			sha256RetrospectiveEvidenceFingerprint,
		),
	);
	assert.deepEqual(
		(await store.list()).map(({ id }) => id),
		["event-b", "event-a"],
	);
	const restarted = await openStore();
	assert.deepEqual(await restarted.show("event-b"), saved.record);
});

test("deduplicates one canonical event across collectors without losing the durable winner", async () => {
	const store = await openStore();
	const first = evidence("collector-z");
	await store.put(first);
	const duplicate = createRetrospectiveEvidence(
		{
			...input("collector-a"),
			capture: {
				capturedAt: "2026-08-27T10:02:00.000Z",
				collector: "repository-cross-reference-v1",
				provenance: "git:commit-1",
			},
		},
		sha256RetrospectiveEvidenceFingerprint,
	);
	const result = await store.put(duplicate);
	assert.equal(result.alreadyPersisted, true);
	assert.equal(result.deduplicatedByFingerprint, true);
	assert.equal(result.record.id, first.id);
	assert.deepEqual(
		(await store.list()).map(({ id }) => id),
		[first.id],
	);
});

test("rejects conflicting ID reuse, forged fingerprints, and canonical fingerprint collisions explicitly", async () => {
	const store = await openStore();
	const first = evidence("stable-id");
	await store.put(first);
	const changed = createRetrospectiveEvidence(
		{ ...input(first.id), representation: { kind: "summary", text: "Different visible event." } },
		sha256RetrospectiveEvidenceFingerprint,
	);
	await assert.rejects(
		() => store.put(changed),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "id-conflict",
	);
	await assert.rejects(
		() => store.put({ ...evidence("forged"), fingerprint: "0".repeat(64) }),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "fingerprint-invalid",
	);
	await fs.rm(path.join(recordsDirectory(), `${first.id}.json`));
	const collisionFingerprint = "f".repeat(64);
	const collidingStore = await openTrustedRetrospectiveEvidenceStore({
		manifestPath,
		projectRoot: projectDir,
		isProjectTrusted: () => true,
		deps: { fingerprint: () => collisionFingerprint },
	});
	const collisionA = createRetrospectiveEvidence(input("collision-a"), () => collisionFingerprint);
	const collisionB = createRetrospectiveEvidence(
		{
			...input("collision-b"),
			source: { kind: "repository-artifact", identity: "commit:def", reference: "git:def" },
		},
		() => collisionFingerprint,
	);
	await collidingStore.put(collisionA);
	await assert.rejects(
		() => collidingStore.put(collisionB),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "fingerprint-conflict",
	);
});

test("fails closed for corrupt JSON, invalid UTF-8, NUL, unsupported version, oversized files, and record-count overflow", async () => {
	const store = await openStore();
	const directory = recordsDirectory();
	await fs.writeFile(path.join(directory, "corrupt.json"), "not-json", "utf8");
	await assert.rejects(
		() => store.list(),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "corrupt-record",
	);
	await fs.rm(path.join(directory, "corrupt.json"));
	await fs.writeFile(path.join(directory, "encoding.json"), Buffer.from([0xc3, 0x28]));
	await assert.rejects(
		() => store.list(),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "corrupt-record",
	);
	await fs.rm(path.join(directory, "encoding.json"));
	await fs.writeFile(path.join(directory, "nul.json"), JSON.stringify({ ...evidence("nul"), id: "bad\0id" }));
	await assert.rejects(
		() => store.list(),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "corrupt-record",
	);
	await fs.rm(path.join(directory, "nul.json"));
	await fs.writeFile(path.join(directory, "future.json"), JSON.stringify({ ...evidence("future"), version: 2 }));
	await assert.rejects(
		() => store.list(),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "unsupported-version",
	);
	await fs.rm(path.join(directory, "future.json"));
	await fs.writeFile(
		path.join(directory, "oversized.json"),
		Buffer.alloc(MAX_RETROSPECTIVE_EVIDENCE_FILE_BYTES + 1, 97),
	);
	await assert.rejects(
		() => store.list(),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "record-oversized",
	);
	await fs.rm(path.join(directory, "oversized.json"));

	const bounded = await openTrustedRetrospectiveEvidenceStore({
		manifestPath,
		projectRoot: projectDir,
		isProjectTrusted: () => true,
		deps: {
			readdir: async () => Array.from({ length: MAX_RETROSPECTIVE_EVIDENCE_RECORDS + 1 }, (_, i) => `${i}.json`),
		},
	});
	await assert.rejects(
		() => bounded.list(),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "capacity-exceeded",
	);
});

test("serializes concurrent writers and never publishes injected partial-write or rename failures", async () => {
	const store = await openStore();
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, index) =>
			store.put(
				createRetrospectiveEvidence(
					{
						...input(`parallel-${index}`),
						source: {
							kind: "bebop-coordination",
							identity: `request:req-${index}`,
							reference: `event:event-${index}`,
						},
					},
					sha256RetrospectiveEvidenceFingerprint,
				),
			),
		),
	);
	assert.equal(results.length, 8);
	assert.equal((await store.list()).length, 8);
	const failing = await openTrustedRetrospectiveEvidenceStore({
		manifestPath,
		projectRoot: projectDir,
		isProjectTrusted: () => true,
		deps: { rename: async () => Promise.reject(new Error("simulated rename failure")) },
	});
	const partial = createRetrospectiveEvidence(
		{
			...input("partial"),
			source: { kind: "repository-artifact", identity: "commit:partial", reference: "git:partial" },
		},
		sha256RetrospectiveEvidenceFingerprint,
	);
	await assert.rejects(
		() => failing.put(partial),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "write-failed",
	);
	await assert.rejects(
		() => store.show("partial"),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "record-not-found",
	);
	const partialWrite = await openTrustedRetrospectiveEvidenceStore({
		manifestPath,
		projectRoot: projectDir,
		isProjectTrusted: () => true,
		deps: {
			writeFile: async (filePath, data) => {
				await fs.writeFile(filePath, data.slice(0, 10), "utf8");
				throw new Error("simulated partial write failure");
			},
		},
	});
	const partialBytes = createRetrospectiveEvidence(
		{
			...input("partial-bytes"),
			source: { kind: "repository-artifact", identity: "commit:partial-bytes", reference: "git:partial-bytes" },
		},
		sha256RetrospectiveEvidenceFingerprint,
	);
	await assert.rejects(
		() => partialWrite.put(partialBytes),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "write-failed",
	);
	await assert.rejects(
		() => store.show("partial-bytes"),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "record-not-found",
	);
	assert.equal(
		(await fs.readdir(recordsDirectory())).some((name) => name.startsWith(".tmp-")),
		false,
	);
});

test("requires trusted project-local storage and rejects traversal and symlink escapes", async () => {
	await assert.rejects(
		() =>
			openTrustedRetrospectiveEvidenceStore({
				manifestPath: path.join(projectDir, "missing", "crew.json"),
				projectRoot: projectDir,
				isProjectTrusted: () => false,
			}),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "untrusted-project",
	);
	const retrospectives = path.join(projectDir, ".pi", "bebop", "retrospectives");
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-retrospective-outside-"));
	await fs.symlink(outside, retrospectives);
	await assert.rejects(
		() => openStore(),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "path-unsafe",
	);
	assert.deepEqual(await fs.readdir(outside), []);
	await fs.rm(retrospectives);
	const store = await openStore();
	await assert.rejects(
		() => store.show("../secret"),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "path-unsafe",
	);
	const records = recordsDirectory();
	await fs.rm(records, { recursive: true, force: true });
	await fs.symlink(outside, records);
	await assert.rejects(
		() => store.put(evidence("escape")),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "path-unsafe",
	);
	await fs.rm(records, { force: true });
	await fs.mkdir(records, { recursive: true });
	const externalRecord = path.join(outside, "external.json");
	await fs.writeFile(externalRecord, JSON.stringify(evidence("symlink-record")));
	await fs.symlink(externalRecord, path.join(records, "symlink-record.json"));
	await assert.rejects(
		() => store.list(),
		(error: unknown) => error instanceof RetrospectiveEvidenceStoreError && error.code === "corrupt-record",
	);
	await fs.rm(outside, { recursive: true, force: true });
});
