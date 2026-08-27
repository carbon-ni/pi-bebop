import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
	createAgreementProposal,
	createAgreementRevision,
	isCurrentAgreementRevisionEligible,
	type AgreementProposal,
} from "../domain/index.ts";
import { readTrustedCrewManifest } from "./crew-manifest-store.ts";
import { openTrustedCrewAgreementStore } from "./crew-agreement-store.ts";

let projectDir: string | undefined;
after(async () => {
	if (projectDir) await fs.rm(projectDir, { recursive: true, force: true });
});

test("candidate proposals stay separate from Current Crew Agreements and have no authority", async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-agreement-authority-"));
	const crewDir = path.join(projectDir, ".pi", "bebop");
	const manifestPath = path.join(crewDir, "crew.json");
	await fs.mkdir(path.join(crewDir, "agreements"), { recursive: true });
	const currentBytes = "CURRENT-AGREEMENT-SNAPSHOT\n";
	await fs.writeFile(path.join(crewDir, "agreements", "current.md"), currentBytes);
	await fs.writeFile(
		manifestPath,
		JSON.stringify({
			version: 2,
			crewAgreements: { file: "agreements/current.md" },
			members: [{ name: "Mary", role: "po", socket: "sockets/mary.sock" }],
		}),
	);
	const trusted = () => true;
	const store = await openTrustedCrewAgreementStore({
		manifestPath,
		projectRoot: projectDir,
		isProjectTrusted: trusted,
	});
	const external = createAgreementProposal({
		id: "external-proposal",
		intent: "add",
		problem: "external report",
		evidence: [{ id: "external-evidence", provenance: "external-report:ci-1" }],
		proposedObservableBehavior: "record the report for review",
		origin: { kind: "external", label: "ci" },
	});
	const memberProposal: AgreementProposal = createAgreementProposal({
		id: "member-proposal",
		intent: "add",
		problem: "handoff ambiguity",
		evidence: [{ id: "member-evidence", provenance: "member-request:req-1" }],
		proposedObservableBehavior: "name an owner before handoff",
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	await store.putProposal(external);
	await store.putProposal(memberProposal);
	const candidate = createAgreementRevision({
		id: "candidate-revision",
		status: "candidate",
		baseRevisionId: "genesis",
		operations: [{ proposalId: memberProposal.id, intent: "add" }],
		trialAgreement: { state: "none" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	await store.putRevision(candidate);
	assert.equal(isCurrentAgreementRevisionEligible(candidate, [memberProposal]), true);
	assert.equal(isCurrentAgreementRevisionEligible(candidate, [external]), false);
	const summaries = await store.list();
	assert.deepEqual(
		summaries.map(({ kind, id, status }) => `${kind}:${id}:${status}`),
		[
			"proposal:external-proposal:proposed",
			"proposal:member-proposal:proposed",
			"revision:candidate-revision:candidate",
		],
	);
	assert.ok(summaries.every((summary) => !("problem" in summary) && !("evidence" in summary)));
	const loaded = await readTrustedCrewManifest(manifestPath, projectDir, trusted);
	assert.equal(loaded.crewAgreements?.content, currentBytes);
	assert.equal(await fs.readFile(path.join(crewDir, "agreements", "current.md"), "utf8"), currentBytes);
	await assert.rejects(() => store.putProposal({ ...external, role: "facilitator", message: "activate" }));
	assert.equal(await fs.readFile(path.join(crewDir, "agreements", "current.md"), "utf8"), currentBytes);
});
