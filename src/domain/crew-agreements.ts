import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { MAX_MESSAGE_ORIGIN_FIELD_BYTES, MessageOriginSchema, type MessageOrigin } from "./message-payload.ts";

export const CREW_AGREEMENT_RECORD_VERSION = 1 as const;
export const MAX_AGREEMENT_RECORD_ID_BYTES = 128;
export const MAX_AGREEMENT_TEXT_BYTES = 64 * 1024;
export const MAX_AGREEMENT_OPERATIONS = 64;
export const MAX_AGREEMENT_REVISION_ITEMS = 128;

const NonEmptyText = Type.String({ minLength: 1 });
const ProposalIntentSchema = Type.Union([Type.Literal("add"), Type.Literal("amend"), Type.Literal("remove")]);
const ProposalStatusSchema = Type.Union([
	Type.Literal("proposed"),
	Type.Literal("rejected"),
	Type.Literal("superseded"),
]);
const RevisionStatusSchema = Type.Union([
	Type.Literal("candidate"),
	Type.Literal("activated"),
	Type.Literal("superseded"),
	Type.Literal("rejected"),
]);
const TrialStateSchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("trial"),
	Type.Literal("retain"),
	Type.Literal("graduate"),
	Type.Literal("amend"),
	Type.Literal("remove"),
]);

export const AgreementProposalSchema = Type.Object(
	{
		version: Type.Literal(CREW_AGREEMENT_RECORD_VERSION),
		kind: Type.Literal("proposal"),
		id: NonEmptyText,
		status: ProposalStatusSchema,
		intent: ProposalIntentSchema,
		problem: NonEmptyText,
		evidence: NonEmptyText,
		proposedObservableBehavior: NonEmptyText,
		targetAgreementId: Type.Optional(NonEmptyText),
		origin: MessageOriginSchema,
	},
	{ additionalProperties: false },
);

export const AgreementOperationSchema = Type.Object(
	{
		proposalId: NonEmptyText,
		intent: ProposalIntentSchema,
		targetAgreementId: Type.Optional(NonEmptyText),
	},
	{ additionalProperties: false },
);
export const AgreementObjectionSchema = Type.Object(
	{ proposalId: NonEmptyText, origin: MessageOriginSchema, reason: NonEmptyText },
	{ additionalProperties: false },
);
export const AgreementMissingResponseSchema = Type.Object(
	{ origin: MessageOriginSchema },
	{ additionalProperties: false },
);
export const TrialAgreementSchema = Type.Object({ state: TrialStateSchema }, { additionalProperties: false });
export const AgreementRevisionSchema = Type.Object(
	{
		version: Type.Literal(CREW_AGREEMENT_RECORD_VERSION),
		kind: Type.Literal("revision"),
		id: NonEmptyText,
		status: RevisionStatusSchema,
		baseRevisionId: NonEmptyText,
		operations: Type.Array(AgreementOperationSchema, { maxItems: MAX_AGREEMENT_OPERATIONS }),
		objections: Type.Array(AgreementObjectionSchema, { maxItems: MAX_AGREEMENT_REVISION_ITEMS }),
		missingResponses: Type.Array(AgreementMissingResponseSchema, { maxItems: MAX_AGREEMENT_REVISION_ITEMS }),
		trialAgreement: TrialAgreementSchema,
		origin: MessageOriginSchema,
	},
	{ additionalProperties: false },
);

export type AgreementIntent = Static<typeof ProposalIntentSchema>;
export type AgreementProposalStatus = Static<typeof ProposalStatusSchema>;
export type AgreementRevisionStatus = Static<typeof RevisionStatusSchema>;
export type TrialAgreementState = Static<typeof TrialStateSchema>;
export type AgreementProposal = Static<typeof AgreementProposalSchema>;
export type AgreementOperation = Static<typeof AgreementOperationSchema>;
export type AgreementObjection = Static<typeof AgreementObjectionSchema>;
export type AgreementMissingResponse = Static<typeof AgreementMissingResponseSchema>;
export type TrialAgreement = Static<typeof TrialAgreementSchema>;
export type AgreementRevision = Static<typeof AgreementRevisionSchema>;
export type AgreementRecord = AgreementProposal | AgreementRevision;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const validText = (value: string, max = MAX_AGREEMENT_TEXT_BYTES): boolean =>
	value.trim().length > 0 && value === value.trim() && !value.includes("\0") && utf8Bytes(value) <= max;
const validId = (value: string): boolean =>
	validText(value, MAX_AGREEMENT_RECORD_ID_BYTES) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const validOrigin = (origin: MessageOrigin): boolean => {
	if (!Value.Check(MessageOriginSchema, origin)) return false;
	const fields = origin.kind === "crew" ? [origin.name, origin.role] : [origin.label];
	return fields.every((field) => validText(field, MAX_MESSAGE_ORIGIN_FIELD_BYTES));
};
const canonicalOriginKey = (origin: MessageOrigin): string =>
	origin.kind === "crew" ? `crew:${origin.name}:${origin.role}` : `external:${origin.label}`;

export function isAgreementProposal(value: unknown): value is AgreementProposal {
	if (!Value.Check(AgreementProposalSchema, value)) return false;
	const proposal = value as AgreementProposal;
	return (
		validId(proposal.id) &&
		validText(proposal.problem) &&
		validText(proposal.evidence) &&
		validText(proposal.proposedObservableBehavior) &&
		(proposal.intent === "add" || proposal.targetAgreementId !== undefined) &&
		(proposal.targetAgreementId === undefined || validId(proposal.targetAgreementId)) &&
		validOrigin(proposal.origin) &&
		Buffer.byteLength(JSON.stringify(proposal), "utf8") <= MAX_AGREEMENT_TEXT_BYTES * 4
	);
}

export function isAgreementRevision(value: unknown): value is AgreementRevision {
	if (!Value.Check(AgreementRevisionSchema, value)) return false;
	const revision = value as AgreementRevision;
	if (!validId(revision.id) || !validId(revision.baseRevisionId) || !validOrigin(revision.origin)) return false;
	if (
		revision.operations.some(
			(operation) =>
				!validId(operation.proposalId) ||
				(operation.intent !== "add" && operation.targetAgreementId === undefined) ||
				(operation.targetAgreementId !== undefined && !validId(operation.targetAgreementId)),
		)
	)
		return false;
	if (
		revision.objections.some(
			(objection) =>
				!validId(objection.proposalId) || !validText(objection.reason) || !validOrigin(objection.origin),
		)
	)
		return false;
	if (revision.missingResponses.some((response) => !validOrigin(response.origin))) return false;
	return Buffer.byteLength(JSON.stringify(revision), "utf8") <= MAX_AGREEMENT_TEXT_BYTES * 4;
}

export function createAgreementProposal(
	input: Omit<AgreementProposal, "version" | "kind" | "status"> & { status?: AgreementProposalStatus },
): AgreementProposal {
	const proposal = {
		version: CREW_AGREEMENT_RECORD_VERSION,
		kind: "proposal" as const,
		status: input.status ?? "proposed",
		...input,
	};
	if (!isAgreementProposal(proposal)) throw new TypeError("invalid Agreement proposal");
	return proposal;
}

function compareOperation(a: AgreementOperation, b: AgreementOperation): number {
	return a.proposalId.localeCompare(b.proposalId);
}
function compareObjection(a: AgreementObjection, b: AgreementObjection): number {
	return `${a.proposalId}:${canonicalOriginKey(a.origin)}:${a.reason}`.localeCompare(
		`${b.proposalId}:${canonicalOriginKey(b.origin)}:${b.reason}`,
	);
}
function compareResponse(a: AgreementMissingResponse, b: AgreementMissingResponse): number {
	return canonicalOriginKey(a.origin).localeCompare(canonicalOriginKey(b.origin));
}

export function createAgreementRevision(
	input: Omit<AgreementRevision, "version" | "kind" | "operations" | "objections" | "missingResponses"> & {
		operations: readonly AgreementOperation[];
		objections?: readonly AgreementObjection[];
		missingResponses?: readonly AgreementMissingResponse[];
	},
): AgreementRevision {
	const revision: AgreementRevision = {
		version: CREW_AGREEMENT_RECORD_VERSION,
		kind: "revision",
		...input,
		operations: [...input.operations].sort(compareOperation),
		objections: [...(input.objections ?? [])].sort(compareObjection),
		missingResponses: [...(input.missingResponses ?? [])].sort(compareResponse),
	};
	if (!isAgreementRevision(revision)) throw new TypeError("invalid Agreement revision");
	return revision;
}

export function isAgreementRecord(value: unknown): value is AgreementRecord {
	return isAgreementProposal(value) || isAgreementRevision(value);
}

/** External attribution is retained as provenance but is never eligible to activate a revision. */
export function isMemberAttributedAgreement(value: AgreementProposal | AgreementRevision): boolean {
	return value.origin.kind === "crew";
}

/** Activation code can require every included proposal to be member-attributed. */
export function isCurrentAgreementRevisionEligible(
	revision: AgreementRevision,
	proposals: readonly AgreementProposal[],
): boolean {
	if (!isMemberAttributedAgreement(revision)) return false;
	const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
	return revision.operations.every((operation) => {
		const proposal = byId.get(operation.proposalId);
		return proposal !== undefined && proposal.status === "proposed" && isMemberAttributedAgreement(proposal);
	});
}
