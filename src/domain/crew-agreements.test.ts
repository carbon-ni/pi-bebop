import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createAgreementProposal,
	createAgreementRevision,
	isAgreementProposal,
	isAgreementRevision,
	isCurrentAgreementRevisionEligible,
	canTransitionAgreementProposalStatus,
	canTransitionAgreementRevisionStatus,
	createAgreementActivationNotice,
	renderActivatedAgreementContent,
	type AgreementProposal,
} from "./index.ts";

test("Agreement proposals retain intent, evidence, and canonical claimed origin", () => {
	const proposal = createAgreementProposal({
		id: "proposal-1",
		intent: "add",
		problem: "handoffs lose ownership",
		evidence: [{ id: "evidence-1", provenance: "member-request:req-1" }],
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
	assert.equal(isAgreementProposal({ ...proposal, evidence: [{ id: "evidence-1", provenance: "\0secret" }] }), false);
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
		trialAgreement: { state: "trial", agreementIds: ["agreement-1"], reviewCondition: "review after seven days" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	assert.deepEqual(
		revision.operations.map(({ proposalId }) => proposalId),
		["proposal-a", "proposal-b"],
	);
	assert.equal(revision.baseRevisionId, "revision-0");
	assert.equal(revision.trialAgreement.state, "trial");
	assert.equal(isAgreementRevision(revision), true);
	assert.equal(revision.contentHash.length, 64);
	assert.equal(isAgreementRevision({ ...revision, contentHash: "0".repeat(64) }), false);
	assert.equal(isCurrentAgreementRevisionEligible(revision, []), false);
});

test("proposal intent, evidence references, trial state, and lifecycle shapes fail closed", () => {
	const add = proposalFixture();
	assert.equal(isAgreementProposal({ ...add, targetAgreementId: "agreement-1" }), false);
	assert.equal(
		isAgreementProposal({
			...add,
			evidence: [
				{ id: "evidence-1", provenance: "raw copied transcript" },
				{ id: "evidence-1", provenance: "duplicate" },
			],
		}),
		false,
	);
	assert.equal(isAgreementProposal({ ...add, unknown: true }), false);
	assert.equal(canTransitionAgreementProposalStatus("proposed", "rejected"), true);
	assert.equal(canTransitionAgreementProposalStatus("rejected", "proposed"), false);
	assert.equal(canTransitionAgreementRevisionStatus("candidate", "activated"), true);
	assert.equal(canTransitionAgreementRevisionStatus("activated", "superseded"), true);
	assert.equal(canTransitionAgreementRevisionStatus("activated", "candidate"), false);
	assert.throws(() =>
		createAgreementRevision({
			id: "invalid-trial",
			status: "candidate",
			baseRevisionId: "genesis",
			operations: [],
			trialAgreement: { state: "trial", agreementIds: [] },
			origin: { kind: "crew", name: "Mary", role: "po" },
		}),
	);
});

function proposalFixture(): AgreementProposal {
	return createAgreementProposal({
		id: "proposal-shape",
		intent: "add",
		problem: "bounded problem",
		evidence: [{ id: "evidence-1", provenance: "request:req-1" }],
		proposedObservableBehavior: "bounded behavior",
		origin: { kind: "crew", name: "Dave", role: "dev" },
	});
}

test("activation notices are bounded and exclude proposal or evidence content", () => {
	const notice = createAgreementActivationNotice("revision-1", "genesis");
	assert.match(notice.content, /revision-1/);
	assert.match(notice.content, /genesis/);
	assert.equal("instructions" in notice, false);
	assert.equal("origin" in notice, false);
	assert.throws(() => createAgreementActivationNotice("bad id/", "genesis"));
});

test("activation rendering applies add, amend, and remove markers deterministically", () => {
	const add = createAgreementProposal({
		id: "proposal-add",
		intent: "add",
		problem: "add",
		evidence: [{ id: "evidence-add", provenance: "test" }],
		proposedObservableBehavior: "name an owner",
		origin: { kind: "crew", name: "Dave", role: "dev" },
	});
	const revision = createAgreementRevision({
		id: "revision-render",
		status: "candidate",
		baseRevisionId: "genesis",
		operations: [{ proposalId: add.id, intent: "add" }],
		trialAgreement: { state: "none" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	const added = renderActivatedAgreementContent("Existing\n", revision, [add]);
	assert.equal(added, "Existing\n<!-- bebop-agreement:proposal-add -->\n- name an owner\n");

	const amend = createAgreementProposal({
		...add,
		id: "proposal-amend",
		intent: "amend",
		targetAgreementId: "proposal-add",
		proposedObservableBehavior: "use the owner field",
	});
	const amendedRevision = createAgreementRevision({
		id: "revision-amend",
		status: "candidate",
		baseRevisionId: "genesis",
		operations: [{ proposalId: amend.id, intent: "amend", targetAgreementId: "proposal-add" }],
		trialAgreement: { state: "none" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	const amended = renderActivatedAgreementContent(added, amendedRevision, [amend]);
	assert.match(amended, /- use the owner field/);
	assert.equal(amended.includes("proposal-amend"), false);

	const remove = createAgreementProposal({
		...add,
		id: "proposal-remove",
		intent: "remove",
		targetAgreementId: "proposal-add",
	});
	const removedRevision = createAgreementRevision({
		id: "revision-remove",
		status: "candidate",
		baseRevisionId: "genesis",
		operations: [{ proposalId: remove.id, intent: "remove", targetAgreementId: "proposal-add" }],
		trialAgreement: { state: "none" },
		origin: { kind: "crew", name: "Mary", role: "po" },
	});
	assert.equal(renderActivatedAgreementContent(added, removedRevision, [remove]), "Existing\n");
	assert.throws(() => renderActivatedAgreementContent("Existing\n", amendedRevision, [amend]), /not present/);
});

test("external attribution is valid provenance but never member-authorized", () => {
	const proposal: AgreementProposal = {
		version: 1,
		kind: "proposal",
		id: "external-1",
		status: "proposed",
		intent: "amend",
		problem: "external report",
		evidence: [{ id: "external-evidence-1", provenance: "external-report:ci-1" }],
		proposedObservableBehavior: "record the observation",
		targetAgreementId: "agreement-1",
		origin: { kind: "external", label: "ci" },
	};
	assert.equal(isAgreementProposal(proposal), true);
});
