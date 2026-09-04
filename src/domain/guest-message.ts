import { isMessagePayload, type MessagePayload } from "./message-payload.ts";
import { GuestOriginSchema, type GuestOrigin } from "./guest-membership.ts";
import { Value } from "@sinclair/typebox/value";
import type { CrewMember } from "./crew-manifest.ts";

/**
 * Crew-scoped Guest messaging selectors.
 *
 * A Guest is an admitted ordinary messaging participant: it may exchange
 * Follow-ups and correlated Member Requests/Responses and join transient Crew
 * Broadcasts, but every outbound action names the exact crew selector and the
 * Guest origin is always derived from the approved runtime binding — never
 * from caller-claimed fields.
 */

export type GuestMessageErrorCode = "invalid-request" | "unknown-member" | "ambiguous-member" | "unknown-sender";

export class GuestMessageError extends Error {
	readonly code: GuestMessageErrorCode;

	constructor(code: GuestMessageErrorCode, message: string) {
		super(message);
		this.name = "GuestMessageError";
		this.code = code;
	}
}

function invalidRequest(message: string): never {
	throw new GuestMessageError("invalid-request", message);
}

export interface GuestMessageInput {
	readonly crew: string;
	readonly message: string;
	readonly instructions?: readonly string[];
}

/** Validates the exact crew selector and message body before any resolution. */
export function validateGuestMessageInput(input: GuestMessageInput): { crew: string } {
	if (
		typeof input.crew !== "string" ||
		input.crew.trim().length === 0 ||
		input.crew !== input.crew.trim() ||
		input.crew.includes("\0")
	)
		invalidRequest("an exact crew selector is required; Guest messaging never guesses a crew");
	if (typeof input.message !== "string" || input.message.trim().length === 0)
		invalidRequest("Guest message content must be a non-empty message");
	const instructions = input.instructions ?? [];
	if (instructions.some((item) => typeof item !== "string" || item.trim().length === 0))
		invalidRequest("Guest message instructions must be non-empty strings");
	return { crew: input.crew };
}

/**
 * Resolves the outbound target inside the selected crew only: exact member
 * name first, then a unique role. There is no crew fallback, prefix match, or
 * cross-crew lookup; ambiguity is an error, never a guess.
 */
export function resolveGuestTarget(
	crewMembers: readonly Pick<CrewMember, "name" | "role">[],
	target: string,
): Pick<CrewMember, "name" | "role"> {
	const byName = crewMembers.find((candidate) => candidate.name === target);
	const byRole = crewMembers.filter((candidate) => candidate.role === target);
	const resolved = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!resolved) {
		if (byRole.length > 1) throw new GuestMessageError("ambiguous-member", `Ambiguous crew role: ${target}`);
		throw new GuestMessageError("unknown-member", `Unknown crew member: ${target}`);
	}
	return { name: resolved.name, role: resolved.role };
}

/** Derives the typed Guest Origin from the approved runtime binding only. */
export function deriveGuestOrigin(guest: { identity: string; name: string }): GuestOrigin {
	const origin = { kind: "guest" as const, identity: guest.identity, name: guest.name };
	if (!Value.Check(GuestOriginSchema, origin)) invalidRequest("guest origin is invalid");
	return origin;
}

/** Builds the validated outbound Guest payload; it never adds a reply route. */
export function createGuestMessagePayload(
	guest: { identity: string; name: string },
	input: Omit<GuestMessageInput, "crew">,
): MessagePayload {
	const payload: MessagePayload = {
		content: input.message,
		origin: deriveGuestOrigin(guest),
		kind: "follow-up",
		...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
	};
	if (!isMessagePayload(payload)) invalidRequest("invalid guest message payload");
	return payload;
}

/** A crew participant that can receive Guest-originated messages. */
export type GuestRecipient =
	| { readonly kind: "member"; readonly name: string; readonly role: string }
	| { readonly kind: "guest"; readonly identity: string; readonly name: string };

export type BuildGuestBroadcastRecipientsInput = {
	readonly crewMembers: readonly Pick<CrewMember, "name" | "role">[];
	/** Approved Guests of this crew in their deterministic registry order. */
	readonly approvedGuests: readonly { identity: string; name: string }[];
	readonly sender: { kind: "member"; name: string } | { kind: "guest"; identity: string; name: string };
};

export type BuildGuestBroadcastRecipientsResult =
	| { readonly ok: true; readonly recipients: readonly GuestRecipient[] }
	| { readonly ok: false; readonly code: "unknown-sender" | "no-recipients" };

/**
 * Deterministic transient Broadcast recipient snapshot: manifest member order
 * first, then approved-Guest registry order. The exact sender is excluded
 * whether it is a Member or a Guest; no Inbox fallback exists here.
 */
export function buildGuestBroadcastRecipients(
	input: BuildGuestBroadcastRecipientsInput,
): BuildGuestBroadcastRecipientsResult {
	const sender = input.sender;
	const guestSender = sender.kind === "guest" ? sender : undefined;
	const memberSenderName = sender.kind === "member" ? sender.name : undefined;
	let recipients: GuestRecipient[];
	if (memberSenderName !== undefined) {
		if (!input.crewMembers.some((candidate) => candidate.name === memberSenderName))
			return { ok: false, code: "unknown-sender" };
		recipients = [
			...input.crewMembers
				.filter((member) => member.name !== memberSenderName)
				.map((member) => ({ kind: "member" as const, name: member.name, role: member.role })),
			...input.approvedGuests.map((guest) => ({
				kind: "guest" as const,
				identity: guest.identity,
				name: guest.name,
			})),
		];
	} else {
		const guestIdentity = guestSender!.identity;
		if (!input.approvedGuests.some((candidate) => candidate.identity === guestIdentity))
			return { ok: false, code: "unknown-sender" };
		recipients = [
			...input.crewMembers.map((member) => ({ kind: "member" as const, name: member.name, role: member.role })),
			...input.approvedGuests
				.filter((guest) => guest.identity !== guestIdentity)
				.map((guest) => ({ kind: "guest" as const, identity: guest.identity, name: guest.name })),
		];
	}
	if (recipients.length === 0) return { ok: false, code: "no-recipients" };
	return { ok: true, recipients };
}
