import { isMessagePayload, type CrewOrigin, type MessagePayload } from "./message-payload.ts";
import type { CrewManifest, CrewMember } from "./crew-manifest.ts";

/**
 * Crew Broadcast is a transient, non-interrupting fan-out of Follow-ups.
 *
 * It is intentionally distinct from Inbox delivery: every other configured
 * member is attempted in manifest order through the live member-message
 * transport. No Inbox item, retry identity, capacity check, or fallback is
 * created here.
 */

export type CrewBroadcastErrorCode = "invalid-request" | "unknown-sender" | "no-recipients" | "invalid-payload";

export class CrewBroadcastError extends Error {
	readonly code: CrewBroadcastErrorCode;

	constructor(code: CrewBroadcastErrorCode, message: string) {
		super(message);
		this.name = "CrewBroadcastError";
		this.code = code;
	}
}

export interface CrewBroadcastInput {
	readonly senderName: string;
	readonly content: string;
	readonly instructions?: readonly string[];
}

function invalidRequest(message: string): never {
	throw new CrewBroadcastError("invalid-request", message);
}

/** Validates the source-owned fields used to build a broadcast payload. */
export function validateBroadcastInput(input: CrewBroadcastInput): void {
	if (
		typeof input.senderName !== "string" ||
		input.senderName.trim().length === 0 ||
		input.senderName.includes("\0")
	) {
		invalidRequest("broadcast sender must be a non-empty canonical member name");
	}
	if (typeof input.content !== "string" || input.content.trim().length === 0) {
		invalidRequest("broadcast content must be a non-empty message");
	}
	const instructions = input.instructions ?? [];
	if (instructions.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		invalidRequest("broadcast instructions must be non-empty strings");
	}
}

/** Derived crew origin for every recipient: never caller-claimed input. */
export function deriveBroadcastOrigin(sender: CrewMember): CrewOrigin {
	return { kind: "crew", name: sender.name, role: sender.role };
}

/** Builds the validated broadcast payload; it never adds a reply route. */
export function createBroadcastPayload(
	sender: CrewMember,
	input: Omit<CrewBroadcastInput, "senderName">,
): MessagePayload {
	validateBroadcastInput({ senderName: sender.name, ...input });
	const payload: MessagePayload = {
		content: input.content,
		origin: deriveBroadcastOrigin(sender),
		kind: "broadcast",
		...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
	};
	if (!isMessagePayload(payload)) throw new CrewBroadcastError("invalid-payload", "invalid crew broadcast message");
	return payload;
}

export interface BroadcastRecipient {
	readonly member: CrewMember;
}

export type BuildBroadcastRecipientsResult =
	| { readonly ok: true; readonly recipients: readonly BroadcastRecipient[] }
	| { readonly ok: false; readonly code: "unknown-sender" | "no-recipients" };

/** Manifest-order recipient snapshot excluding the sender by canonical identity. */
export function buildBroadcastRecipients(manifest: CrewManifest, senderName: string): BuildBroadcastRecipientsResult {
	const sender = manifest.members.find((candidate) => candidate.name === senderName);
	if (!sender) return { ok: false, code: "unknown-sender" };
	const recipients = manifest.members.filter((member) => member.name !== sender.name).map((member) => ({ member }));
	if (recipients.length === 0) return { ok: false, code: "no-recipients" };
	return { ok: true, recipients };
}

export interface BroadcastDisposition {
	readonly recipientName: string;
	readonly recipientRole: string;
	readonly deliveryId?: string;
	readonly disposition: "delivered" | "failed";
	/** Stable failure code when disposition is failed (for example offline). */
	readonly code?: string;
	readonly message?: string;
}

export interface BroadcastSummary {
	readonly delivered: number;
	readonly failed: number;
	readonly total: number;
}

/** Counts every attempted recipient without masking partial failures. */
export function summarizeBroadcastDispositions(dispositions: readonly BroadcastDisposition[]): BroadcastSummary {
	let delivered = 0;
	let failed = 0;
	for (const disposition of dispositions) {
		if (disposition.disposition === "delivered") delivered += 1;
		else failed += 1;
	}
	return { delivered, failed, total: dispositions.length };
}

export type CrewBroadcastResult =
	| {
			readonly ok: true;
			readonly dispositions: readonly BroadcastDisposition[];
			readonly summary: BroadcastSummary;
	  }
	| { readonly ok: false; readonly code: "unknown-sender" | "no-recipients" };

export function noRecipientsResult(code: "unknown-sender" | "no-recipients"): CrewBroadcastResult {
	return { ok: false, code };
}
