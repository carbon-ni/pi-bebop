import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createAgreementProposal,
	createAgreementRevision,
	isAgreementProposal,
	isAgreementRevision,
	isCurrentAgreementRevisionEligible,
	type AgreementProposal,
} from "./index.ts";

test("Agreement proposals retain intent, evidence, and canonical claimed origin", () => {
	const proposal = createAgreementProposal({
		id: "proposal-1",
		intent: "add",
		problem: "handoffs lose ownership",
		evidence: "three accepted requests lacked an owner",
		proposedObservableBehavior: "name the owner before sending a handoff",
		origin: { kind: "crew", name: "Dave", role: "dev" },
	});
	assert.equal(proposal.version, 1);
	assert.equal(proposal.kind, "proposal");
	assert.equal(proposal.status, "proposed");
	assert.equal(isAgreementProposal(proposal), true);
	assert.equal(
		isAgreementProposal({ ...proposal, origin: { kind: "crew", name: "Dave", role: "dev", authority: true } }),
		false,
	);
	assert.equal(isAgreementProposal({ ...proposal, evidence: "\0secret" }), false);
});

test("Agreement revisions sort included operations and review gaps deterministically", () => {
	const revision = createAgreementRevision({
		id: "revision-1",
		status: "candidate",
		baseRevisionId: "revision-0",
		operations: [
			{ proposalId: "proposal-b", intent: "remove", targetAgreementId: "agreement-1" },
			{ proposalId: "proposal-a", intent: "add" },
		],
		objections: [
			{ proposalId: "proposal-b", origin: { kind: "crew", name: "Zoe", role: "qa" }, reason: "not observable" },
		],
		missingResponses: [{ origin: { kind: "crew", name: "Amy", role: "po" } }],
		trialAgreement: { state: "trial" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	assert.deepEqual(
		revision.operations.map(({ proposalId }) => proposalId),
		["proposal-a", "proposal-b"],
	);
	assert.equal(revision.baseRevisionId, "revision-0");
	assert.equal(revision.trialAgreement.state, "trial");
	assert.equal(isAgreementRevision(revision), true);
	assert.equal(isCurrentAgreementRevisionEligible(revision, []), false);
});

test("external attribution is valid provenance but never member-authorized", () => {
	const proposal: AgreementProposal = {
		version: 1,
		kind: "proposal",
		id: "external-1",
		status: "proposed",
		intent: "amend",
		problem: "external report",
		evidence: "reported observation",
		proposedObservableBehavior: "record the observation",
		targetAgreementId: "agreement-1",
		origin: { kind: "external", label: "ci" },
	};
	assert.equal(isAgreementProposal(proposal), true);
});
