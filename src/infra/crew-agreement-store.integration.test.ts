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

test("trusted activation changes Current Crew Agreements only through an eligible candidate", async () => {
	const activationProject = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-agreement-activation-"));
	try {
		const crewDir = path.join(activationProject, ".pi", "bebop");
		const manifestPath = path.join(crewDir, "crew.json");
		const currentPath = path.join(crewDir, "agreements", "current.md");
		await fs.mkdir(path.dirname(currentPath), { recursive: true });
		await fs.writeFile(currentPath, "Current\n");
		await fs.writeFile(
			manifestPath,
			JSON.stringify({
				version: 2,
				crewAgreements: { file: "agreements/current.md" },
				members: [{ name: "Mary", role: "po", socket: "sockets/mary.sock" }],
			}),
		);
		const store = await openTrustedCrewAgreementStore({
			manifestPath,
			projectRoot: activationProject,
			isProjectTrusted: () => true,
		});
		const proposal = createAgreementProposal({
			id: "activation-proposal",
			intent: "add",
			problem: "handoff ambiguity",
			evidence: [{ id: "activation-evidence", provenance: "member-request:req-1" }],
			proposedObservableBehavior: "name an owner before handoff",
			origin: { kind: "crew", name: "Mary", role: "po" },
		});
		const revision = createAgreementRevision({
			id: "activation-revision",
			status: "candidate",
			baseRevisionId: "genesis",
			operations: [{ proposalId: proposal.id, intent: "add" }],
			trialAgreement: { state: "none" },
			origin: { kind: "crew", name: "Mary", role: "po" },
		});
		await store.putProposal(proposal);
		await store.putRevision(revision);
		const activated = await store.activateRevision(revision.id);
		assert.deepEqual(activated, {
			revisionId: revision.id,
			priorRevisionId: "genesis",
			disposition: "activated",
		});
		assert.match(await fs.readFile(currentPath, "utf8"), /name an owner before handoff/);
		assert.equal((await store.activateRevision(revision.id)).disposition, "unchanged");
		assert.equal((await store.list("revision")).find((item) => item.id === revision.id)?.status, "activated");
		assert.equal((await store.show("revision", revision.id)).status, "activated");
	} finally {
		await fs.rm(activationProject, { recursive: true, force: true });
	}
});

test("activation rejects external authority and stale bases without mutating Current Crew Agreements", async () => {
	const activationProject = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-agreement-activation-failures-"));
	try {
		const crewDir = path.join(activationProject, ".pi", "bebop");
		const manifestPath = path.join(crewDir, "crew.json");
		const currentPath = path.join(crewDir, "agreements", "current.md");
		await fs.mkdir(path.dirname(currentPath), { recursive: true });
		await fs.writeFile(currentPath, "Current\n");
		await fs.writeFile(
			manifestPath,
			JSON.stringify({
				version: 2,
				crewAgreements: { file: "agreements/current.md" },
				members: [{ name: "Mary", role: "po", socket: "sockets/mary.sock" }],
			}),
		);
		const store = await openTrustedCrewAgreementStore({
			manifestPath,
			projectRoot: activationProject,
			isProjectTrusted: () => true,
		});
		const memberProposal = createAgreementProposal({
			id: "member-activation-proposal",
			intent: "add",
			problem: "p",
			evidence: [{ id: "e", provenance: "member" }],
			proposedObservableBehavior: "member behavior",
			origin: { kind: "crew", name: "Mary", role: "po" },
		});
		const externalProposal = createAgreementProposal({
			...memberProposal,
			id: "external-activation-proposal",
			origin: { kind: "external", label: "automation" },
		});
		const first = createAgreementRevision({
			id: "first-activation-revision",
			status: "candidate",
			baseRevisionId: "genesis",
			operations: [{ proposalId: memberProposal.id, intent: "add" }],
			trialAgreement: { state: "none" },
			origin: { kind: "crew", name: "Mary", role: "po" },
		});
		const stale = createAgreementRevision({
			id: "stale-activation-revision",
			status: "candidate",
			baseRevisionId: "genesis",
			operations: [{ proposalId: memberProposal.id, intent: "add" }],
			trialAgreement: { state: "none" },
			origin: { kind: "crew", name: "Mary", role: "po" },
		});
		const external = createAgreementRevision({
			id: "external-activation-revision",
			status: "candidate",
			baseRevisionId: "genesis",
			operations: [{ proposalId: externalProposal.id, intent: "add" }],
			trialAgreement: { state: "none" },
			origin: { kind: "external", label: "automation" },
		});
		await store.putProposal(memberProposal);
		await store.putProposal(externalProposal);
		await store.putRevision(first);
		await store.putRevision(stale);
		await store.putRevision(external);
		await store.activateRevision(first.id);
		const currentAfterFirst = await fs.readFile(currentPath, "utf8");
		await assert.rejects(
			() => store.activateRevision(stale.id),
			(error: unknown) => error instanceof Error && "code" in error && error.code === "stale-base",
		);
		await assert.rejects(
			() => store.activateRevision(external.id),
			(error: unknown) => error instanceof Error && "code" in error && error.code === "activation-conflict",
		);
		assert.equal(await fs.readFile(currentPath, "utf8"), currentAfterFirst);
	} finally {
		await fs.rm(activationProject, { recursive: true, force: true });
	}
});

test("activation fails closed on corrupt state and preserves the loaded Membership snapshot", async () => {
	const activationProject = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-agreement-activation-corrupt-"));
	try {
		const crewDir = path.join(activationProject, ".pi", "bebop");
		const manifestPath = path.join(crewDir, "crew.json");
		const currentPath = path.join(crewDir, "agreements", "current.md");
		await fs.mkdir(path.dirname(currentPath), { recursive: true });
		await fs.writeFile(currentPath, "Current\n");
		await fs.writeFile(
			manifestPath,
			JSON.stringify({
				version: 2,
				crewAgreements: { file: "agreements/current.md" },
				members: [{ name: "Mary", role: "po", socket: "sockets/mary.sock" }],
			}),
		);
		const store = await openTrustedCrewAgreementStore({
			manifestPath,
			projectRoot: activationProject,
			isProjectTrusted: () => true,
		});
		const proposal = createAgreementProposal({
			id: "corrupt-state-proposal",
			intent: "add",
			problem: "p",
			evidence: [{ id: "corrupt-state-evidence", provenance: "member" }],
			proposedObservableBehavior: "behavior",
			origin: { kind: "crew", name: "Mary", role: "po" },
		});
		const revision = createAgreementRevision({
			id: "corrupt-state-revision",
			status: "candidate",
			baseRevisionId: "genesis",
			operations: [{ proposalId: proposal.id, intent: "add" }],
			trialAgreement: { state: "none" },
			origin: { kind: "crew", name: "Mary", role: "po" },
		});
		await store.putProposal(proposal);
		await store.putRevision(revision);
		const snapshot = await readTrustedCrewManifest(manifestPath, activationProject, () => true);
		await store.activateRevision(revision.id);
		assert.equal(snapshot.crewAgreements?.content, "Current\n");
		await fs.writeFile(path.join(crewDir, "agreements", "history", "activation.json"), "{}\n");
		await assert.rejects(
			() => store.list("revision"),
			(error: unknown) => error instanceof Error && "code" in error && error.code === "corrupt-record",
		);
	} finally {
		await fs.rm(activationProject, { recursive: true, force: true });
	}
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
