import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createAgreementProposal, createAgreementRevision, type AgreementProposal } from "../domain/index.ts";
import {
	CrewAgreementStoreError,
	MAX_AGREEMENT_RECORD_FILE_BYTES,
	openTrustedCrewAgreementStore,
} from "./crew-agreement-store.ts";

let projectDir: string;
let manifestPath: string;

before(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-agreements-"));
	manifestPath = path.join(projectDir, ".pi", "bebop", "crew.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, "{}", "utf8");
});
after(async () => fs.rm(projectDir, { recursive: true, force: true }));

async function openStore() {
	return await openTrustedCrewAgreementStore({ manifestPath, projectRoot: projectDir, isProjectTrusted: () => true });
}
function proposal(id: string): AgreementProposal {
	return createAgreementProposal({
		id,
		intent: "add",
		problem: "handoff ambiguity",
		evidence: [{ id: `${id}-evidence`, provenance: "member-request:req-1" }],
		proposedObservableBehavior: "name an owner before handoff",
		origin: { kind: "crew", name: "Dave", role: "dev" },
	});
}

test("persists, restarts, lists, and shows proposals without exposing unrelated records", async () => {
	const store = await openStore();
	const saved = await store.putProposal(proposal("proposal-1"));
	assert.equal(saved.record.id, "proposal-1");
	assert.equal((await store.putProposal(proposal("proposal-1"))).alreadyPersisted, true);
	const reordered = JSON.parse(JSON.stringify(proposal("proposal-1"))) as Record<string, unknown>;
	const reorderedKeys = Object.keys(reordered).reverse();
	const reorderedRecord = Object.fromEntries(reorderedKeys.map((key) => [key, reordered[key]]));
	assert.equal((await store.putProposal(reorderedRecord)).alreadyPersisted, true);
	assert.deepEqual((await store.show("proposal", "proposal-1")).kind, "proposal");
	assert.deepEqual(
		(await store.list("proposal")).map((item) => item.id),
		["proposal-1"],
	);
	const restarted = await openStore();
	assert.equal((await restarted.show("proposal", "proposal-1")).id, "proposal-1");
});

test("rejects a revision whose exact base is missing", async () => {
	const store = await openStore();
	const revision = createAgreementRevision({
		id: "stale-revision",
		status: "candidate",
		baseRevisionId: "missing-base",
		operations: [],
		trialAgreement: { state: "none" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	await assert.rejects(
		() => store.putRevision(revision),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "stale-base",
	);
});

test("rejects revisions with missing or incompatible proposal references", async () => {
	const store = await openStore();
	const revision = createAgreementRevision({
		id: "missing-proposal-revision",
		status: "candidate",
		baseRevisionId: "genesis",
		operations: [{ proposalId: "not-persisted", intent: "add" }],
		trialAgreement: { state: "none" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	await assert.rejects(
		() => store.putRevision(revision),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "invalid-reference",
	);
	await store.putProposal(
		createAgreementProposal({ ...proposal("amend-proposal"), intent: "amend", targetAgreementId: "agreement-1" }),
	);
	const incompatible = createAgreementRevision({
		id: "incompatible-revision",
		status: "candidate",
		baseRevisionId: "genesis",
		operations: [{ proposalId: "amend-proposal", intent: "remove", targetAgreementId: "agreement-1" }],
		trialAgreement: { state: "none" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	await assert.rejects(
		() => store.putRevision(incompatible),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "invalid-reference",
	);
});

test("records deterministic candidate revision state and separates it from proposals", async () => {
	const store = await openStore();
	const revision = createAgreementRevision({
		id: "revision-1",
		status: "candidate",
		baseRevisionId: "genesis",
		operations: [{ proposalId: "proposal-1", intent: "add" }],
		missingResponses: [{ origin: { kind: "crew", name: "Kelly", role: "qa" } }],
		trialAgreement: { state: "trial", agreementIds: ["agreement-1"], reviewCondition: "review after seven days" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	await store.putRevision(revision);
	assert.deepEqual(
		(await store.list()).map((item) => `${item.kind}:${item.status}`),
		["proposal:proposed", "proposal:proposed", "revision:candidate"],
	);
});

test("rejects malformed, unsafe, corrupt, oversized, and conflicting records closed", async () => {
	const store = await openStore();
	await assert.rejects(
		() => store.putProposal({ id: "../../secret" }),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "invalid-proposal",
	);
	await assert.rejects(
		() => store.show("proposal", "../secret"),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "path-unsafe",
	);
	await assert.rejects(
		() => store.putProposal({ ...proposal("proposal-1"), problem: "different" }),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "idempotency-conflict",
	);
	const corrupt = path.join(projectDir, ".pi", "bebop", "agreements", "history", "proposals", "corrupt.json");
	await fs.writeFile(corrupt, "not-json", "utf8");
	await assert.rejects(
		() => store.list("proposal"),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "corrupt-record",
	);
	await fs.rm(corrupt);
	const oversized = path.join(projectDir, ".pi", "bebop", "agreements", "history", "proposals", "oversized.json");
	await fs.writeFile(oversized, Buffer.alloc(MAX_AGREEMENT_RECORD_FILE_BYTES + 1, 97));
	await assert.rejects(
		() => store.list("proposal"),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "record-oversized",
	);
	await fs.rm(oversized);
});

test("atomic temp failure does not publish a partial record and concurrent writes serialize", async () => {
	const store = await openStore();
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, index) => store.putProposal(proposal(`concurrent-${index}`))),
	);
	assert.equal(results.length, 8);
	assert.equal((await store.list("proposal")).filter((item) => item.id.startsWith("concurrent-")).length, 8);
	const failing = await openTrustedCrewAgreementStore({
		manifestPath,
		projectRoot: projectDir,
		isProjectTrusted: () => true,
		deps: {
			rename: async () => {
				throw new Error("simulated rename failure");
			},
		},
	});
	await assert.rejects(
		() => failing.putProposal(proposal("partial")),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "write-failed",
	);
	await assert.rejects(
		() => store.show("proposal", "partial"),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "record-not-found",
	);
});

test("rejects symlinked record directories and record files", async () => {
	const store = await openStore();
	const agreements = path.join(projectDir, ".pi", "bebop", "agreements");
	const history = path.join(agreements, "history");
	const proposals = path.join(history, "proposals");
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-agreements-outside-"));
	await fs.rm(proposals, { recursive: true, force: true });
	await fs.symlink(outside, proposals);
	await assert.rejects(
		() => store.putProposal(proposal("directory-escape")),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "path-unsafe",
	);
	await fs.rm(proposals, { force: true });
	await fs.mkdir(proposals, { recursive: true });
	const outsideRecord = path.join(outside, "record.json");
	await fs.writeFile(outsideRecord, JSON.stringify(proposal("symlink-record")));
	await fs.symlink(outsideRecord, path.join(proposals, "symlink-record.json"));
	await assert.rejects(
		() => store.list("proposal"),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "corrupt-record",
	);
	await fs.rm(outside, { recursive: true, force: true });
});

test("trust is checked before history IO", async () => {
	await assert.rejects(
		() =>
			openTrustedCrewAgreementStore({
				manifestPath: path.join(projectDir, "missing", "crew.json"),
				projectRoot: projectDir,
				isProjectTrusted: () => false,
			}),
		(error: unknown) => error instanceof CrewAgreementStoreError && error.code === "untrusted-project",
	);
});
