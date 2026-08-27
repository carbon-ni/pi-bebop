/**
 * Allow-listed coordination event types for retrospective evidence collection.
 *
 * These types describe mechanical facts that Bebop already owns —
 * request/response outcomes, delivery dispositions, broadcast outcomes,
 * interrupt lifecycle, and membership failures. They never carry
 * hidden reasoning, productivity claims, or intent interpretations.
 */

/**
 * Canonical outcome vocabulary. Each value maps to exactly one mechanical
 * state; timeout/offline/accepted/persisted/handoff/idle/completion
 * are never conflated.
 */
export type CoordinationOutcomeKind =
	| "member-request-response"
	| "member-request-offline"
	| "member-request-timeout-max-wait"
	| "member-request-timeout-response-after-idle"
	| "member-request-outcome-unknown"
	| "member-message-queued"
	| "member-message-direct"
	| "member-message-steered"
	| "member-message-delivery-failed"
	| "broadcast-persisted"
	| "broadcast-already-persisted"
	| "broadcast-failed"
	| "broadcast-no-recipients"
	| "interrupt-pending"
	| "interrupt-handoff"
	| "interrupt-direct"
	| "interrupt-abort-failed"
	| "interrupt-no-context"
	| "interrupt-handoff-failed"
	| "interrupt-already-pending"
	| "inbox-enqueued"
	| "inbox-capacity-exceeded"
	| "inbox-invalid-payload"
	| "inbox-offered"
	| "inbox-cancelled"
	| "inbox-item-not-found"
	| "inbox-acknowledged"
	| "membership-join-failed"
	| "membership-leave-failed"
	| "membership-stop-failed"
	| "membership-release-failed";

/**
 * Mechanical context that may appear alongside evidence but never
 * as productivity, intent, availability, or semantic interpretation.
 */
export interface CoordinationMechanicalContext {
	readonly idle?: true;
	readonly busy?: true;
	readonly compacting?: true;
}

/** Allow-listed coordination event families. */
export type CoordinationEventFamily =
	| "member-request"
	| "member-message"
	| "broadcast"
	| "interrupt"
	| "inbox"
	| "membership";

/** Source reference for a coordination event. */
export interface CoordinationEventSource {
	readonly family: CoordinationEventFamily;
	readonly identity: string;
	readonly reference: string;
}

/** A collected coordination fact with canonical IDs and outcome vocabulary. */
export interface CoordinationEvent {
	readonly source: CoordinationEventSource;
	readonly outcome: CoordinationOutcomeKind;
	readonly occurredAt: string;
	readonly context?: CoordinationMechanicalContext;
	readonly memberId?: string;
	readonly targetMemberId?: string;
	readonly correlationId?: string;
	readonly errorCode?: string;
	readonly contentSummary?: string;
}

/**
 * Maps a coordination event family to its source identity pattern.
 * Member request events use the request ID as identity; broadcast uses broadcast ID, etc.
 */
export function coordinationEventFamily(family: CoordinationEventFamily): string {
	const families: Record<CoordinationEventFamily, string> = {
		"member-request": "bebop.member-request",
		"member-message": "bebop.member-message",
		broadcast: "bebop.broadcast",
		interrupt: "bebop.interrupt",
		inbox: "bebop.inbox",
		membership: "bebop.membership",
	};
	return families[family];
}

/**
 * Builds a deterministic evidence ID from event family, correlation ID,
 * and outcome kind. Same event + same outcome always produces the same ID,
 * enabling idempotent replay.
 */
export function coordinationEvidenceId(
	family: CoordinationEventFamily,
	correlationId: string,
	outcome: CoordinationOutcomeKind,
): string {
	return `${family}.${correlationId}.${outcome}`;
}

/**
 * Bounded content summary: truncates to a byte limit and appends a
 * truncation marker if needed. Ordinary visible Crew work is preserved;
 * hidden reasoning is never available to collect.
 */
export const MAX_COORDINATION_CONTENT_SUMMARY_BYTES = 1024;
export const COORDINATION_TRUNCATION_MARKER = "[truncated]";

export function boundContentSummary(value: string, maxBytes: number = MAX_COORDINATION_CONTENT_SUMMARY_BYTES): string {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	const marker = encoder.encode(COORDINATION_TRUNCATION_MARKER);
	const budget = maxBytes - marker.byteLength;
	if (budget <= 0) return COORDINATION_TRUNCATION_MARKER;
	// Truncate at UTF-8 boundary
	let end = budget;
	while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
	const truncated = new TextDecoder("utf-8", { fatal: true }).decode(encoded.slice(0, end));
	return truncated + COORDINATION_TRUNCATION_MARKER;
}

/**
 * Valid mechanical context: at most one of idle/busy/compacting.
 * Multiple flags or unknown flags are rejected.
 */
export function isValidMechanicalContext(ctx: CoordinationMechanicalContext): boolean {
	const flags = [ctx.idle, ctx.busy, ctx.compacting].filter(Boolean).length;
	return flags <= 1;
}

/**
 * Builds a source identity string from family and primary ID.
 */
export function coordinationSourceIdentity(family: CoordinationEventFamily, primaryId: string): string {
	return `${coordinationEventFamily(family)}.${primaryId}`;
}

/**
 * Builds a source reference string from event specifics.
 */
export function coordinationSourceReference(
	family: CoordinationEventFamily,
	primaryId: string,
	outcome: CoordinationOutcomeKind,
): string {
	return `${coordinationEventFamily(family)}.${primaryId}.${outcome}`;
}

/** Activity/Presence may appear ONLY as mechanical context —
 * never as productivity, intent, availability, or semantic interpretation.
 * This type guard enforces the UL distinction at the boundary. */
export function isMechanicalContextOnly(value: unknown): value is CoordinationMechanicalContext {
	if (typeof value !== "object" || value === null) return false;
	const ctx = value as Record<string, unknown>;
	const allowed = new Set(["idle", "busy", "compacting"]);
	for (const key of Object.keys(ctx)) {
		if (!allowed.has(key)) return false;
	}
	return isValidMechanicalContext(ctx as CoordinationMechanicalContext);
}
