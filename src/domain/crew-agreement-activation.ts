import {
	MAX_AGREEMENT_RECORD_ID_BYTES,
	MAX_AGREEMENT_TEXT_BYTES,
	type AgreementProposal,
	type AgreementRevision,
} from "./crew-agreements.ts";
import { isMessagePayload, type MessagePayload } from "./message-payload.ts";

const AGREEMENT_MARKER = "<!-- bebop-agreement:";
const MAX_ACTIVATED_CONTENT_BYTES = MAX_AGREEMENT_TEXT_BYTES;
const MAX_NOTICE_BYTES = 4 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Builds the bounded system-produced Inbox notice sent after durable activation. */
export function createAgreementActivationNotice(revisionId: string, priorRevisionId: string): MessagePayload {
	if (
		revisionId.length === 0 ||
		priorRevisionId.length === 0 ||
		!idPattern.test(revisionId) ||
		!idPattern.test(priorRevisionId) ||
		Buffer.byteLength(revisionId, "utf8") > MAX_AGREEMENT_RECORD_ID_BYTES ||
		Buffer.byteLength(priorRevisionId, "utf8") > MAX_AGREEMENT_RECORD_ID_BYTES
	)
		throw new TypeError("invalid Agreement revision identity");
	const content = `Agreement revision ${revisionId} is active (previous revision: ${priorRevisionId}). It applies on the next Membership snapshot; active sessions are unchanged.`;
	const payload: MessagePayload = { content };
	if (!isMessagePayload(payload) || Buffer.byteLength(content, "utf8") > MAX_NOTICE_BYTES)
		throw new TypeError("invalid Agreement activation notice");
	return payload;
}

/**
 * Applies an immutable candidate to the Markdown Current Crew Agreements
 * projection. Agreement sections are deliberately marked so amend/remove can
 * be deterministic without treating arbitrary prose as structured state.
 */
export function renderActivatedAgreementContent(
	currentContent: string,
	revision: AgreementRevision,
	proposals: readonly AgreementProposal[],
): string {
	const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
	let content = currentContent;
	for (const operation of revision.operations) {
		const proposal = byId.get(operation.proposalId);
		if (proposal === undefined) throw new Error(`missing Agreement proposal: ${operation.proposalId}`);
		const targetId = operation.targetAgreementId;
		if (operation.intent === "add") {
			content = appendAgreement(content, proposal.id, proposal.proposedObservableBehavior);
			continue;
		}
		if (targetId === undefined) throw new Error(`missing target Agreement ID: ${operation.proposalId}`);
		const section = agreementSection(content, targetId);
		if (section === undefined) throw new Error(`target Agreement is not present: ${targetId}`);
		if (operation.intent === "remove") {
			content = `${content.slice(0, section.start)}${content.slice(section.end)}`;
			continue;
		}
		content = `${content.slice(0, section.start)}${agreementBlock(
			targetId,
			proposal.proposedObservableBehavior,
		)}${content.slice(section.end)}`;
	}
	if (Buffer.byteLength(content, "utf8") > MAX_ACTIVATED_CONTENT_BYTES) {
		throw new Error(`Current Crew Agreements exceed ${MAX_ACTIVATED_CONTENT_BYTES} UTF-8 bytes`);
	}
	return content;
}

function agreementBlock(id: string, behavior: string): string {
	return `${AGREEMENT_MARKER}${id} -->\n- ${behavior}\n`;
}

function appendAgreement(content: string, id: string, behavior: string): string {
	const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
	return `${content}${separator}${agreementBlock(id, behavior)}`;
}

function agreementSection(content: string, id: string): { start: number; end: number } | undefined {
	const marker = `${AGREEMENT_MARKER}${id} -->`;
	const start = content.indexOf(marker);
	if (start < 0) return undefined;
	const next = content.indexOf(AGREEMENT_MARKER, start + marker.length);
	const end = next < 0 ? content.length : next;
	return { start, end };
}
