import type { CrewManifest, CrewMember } from "./crew-manifest.ts";
import { isMessagePayload, type MessagePayload } from "./message-payload.ts";

/**
 * Crew Intake domain contract (TASK-0040).
 *
 * Intake is the public one-way boundary for messages crossing from an external
 * actor into the crew. It owns the external-facing contract, exact contact
 * selection, claimed/unverified external origin, and one-way persisted
 * acknowledgement semantics; Inbox owns persistence and delivery only.
 *
 * - The crew contact is selected by exact configured member NAME from the
 *   validated manifest (`intake.contact`). There is no role match, no fallback
 *   to lead/PO/first-online, and no implicit default: absent contact means
 *   intake is disabled (`external-intake-disabled`).
 * - External origin labels are claimed and unverified. Contact identity and
 *   inbox location come only from the validated manifest, never from the
 *   caller.
 * - Intake is one-way for MVP: the persisted acknowledgement contains no reply
 *   route and promises no response. Bebop does not classify content, select an
 *   internal worker, or infer that intake became accepted software work.
 */

export type CrewIntakeErrorCode = "unknown-contact" | "invalid-payload";

export class CrewIntakeError extends Error {
	readonly code: CrewIntakeErrorCode;

	constructor(code: CrewIntakeErrorCode, message: string) {
		super(message);
		this.name = "CrewIntakeError";
		this.code = code;
	}
}

export type IntakeResolution =
	| { readonly enabled: true; readonly contact: CrewMember }
	| { readonly enabled: false; readonly reason: "external-intake-disabled" };

/** Resolves the crew contact from a validated manifest; disabled when no contact is configured. */
export function resolveIntakeContact(manifest: CrewManifest): IntakeResolution {
	const contact = manifest.intake?.contact;
	if (contact === undefined) return { enabled: false, reason: "external-intake-disabled" };
	const member = manifest.members.find((candidate) => candidate.name === contact);
	if (!member) throw new CrewIntakeError("unknown-contact", `intake contact is not a configured member: ${contact}`);
	return { enabled: true, contact: member };
}

export interface ExternalIntakeMessageInput {
	readonly label: string;
	readonly content: string;
	readonly instructions?: readonly string[];
}

/** Builds a one-way structured payload with claimed, unverified external origin; never adds a reply route. */
export function createExternalIntakePayload(input: ExternalIntakeMessageInput): MessagePayload {
	const payload: MessagePayload = {
		content: input.content,
		origin: { kind: "external", label: input.label },
		...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
	};
	if (!isMessagePayload(payload)) throw new CrewIntakeError("invalid-payload", "invalid external intake message");
	return payload;
}

/**
 * One-way persisted acknowledgement. It proves durability only: no reply route
 * and no promised response. TASK-0041's CLI produces this after the item is
 * persisted to the contact's inbox.
 */
export interface ExternalIntakeAck {
	readonly ok: true;
	readonly itemId: string;
	readonly persisted: true;
	readonly contact: string;
	readonly contactRole: string;
}

export function isExternalIntakeAck(value: unknown): value is ExternalIntakeAck {
	if (typeof value !== "object" || value === null) return false;
	const ack = value as Record<string, unknown>;
	return (
		ack.ok === true &&
		ack.persisted === true &&
		typeof ack.itemId === "string" &&
		ack.itemId.length > 0 &&
		typeof ack.contact === "string" &&
		ack.contact.length > 0 &&
		typeof ack.contactRole === "string" &&
		ack.contactRole.length > 0 &&
		!("replyTo" in ack) &&
		!("sessionId" in ack) &&
		!("response" in ack)
	);
}
