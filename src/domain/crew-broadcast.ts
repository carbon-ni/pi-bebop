import { isMessagePayload, type CrewOrigin, type MessagePayload } from "./message-payload.ts";
import type { CrewManifest, CrewMember } from "./crew-manifest.ts";

/**
 * Crew Broadcast domain contract (TASK-0042).
 *
 * Broadcast is an internal, durable, non-interrupting fan-out initiated by
 * the current joined member. The same structured message is persisted
 * independently to every other member configured by the current trusted
 * manifest, in manifest order, regardless of presence. The sender is excluded
 * by exact canonical member identity (unique member name from the validated
 * manifest) — never by name/role heuristics.
 *
 * Semantics and boundaries:
 * - Internal only: the initiator must resolve to a configured manifest member
 *   (`unknown-sender` otherwise). Joined-ness and membership are enforced by
 *   the application layer before this contract runs; external actors use Crew
 *   Intake, which is a separate one-way boundary.
 * - Derived origin: every recipient payload carries the initiator's crew
 *   origin derived from the manifest member — never from caller-claimed input.
 * - Non-interrupting: broadcast always persists through each recipient's
 *   Inbox and is later handed off as a normal Follow-up (TASK-0037 bridge).
 *   It can never steer or redirect active work.
 * - Durable fan-out with idempotent retry: a stable broadcast id plus
 *   deterministic per-recipient item ids let a retry fill missing recipients
 *   without duplicating successful copies. Recipient item identity depends
 *   only on the broadcast id and the recipient's canonical name — never on
 *   inbox sequence — so interleaved inbox activity cannot change it.
 * - No-recipient no-IO: when self exclusion empties the recipient set, the
 *   contract returns an explicit no-recipients outcome and no storage IO is
 *   performed.
 * - Per-recipient isolation: one recipient's failure or full inbox does not
 *   corrupt other recipients, and the failed target is never silently lost:
 *   every target reports a disposition.
 *
 * Broadcast is not Crew Intake (external one-way boundary), not a shared
 * inbox (per-recipient independent copies), not a group turn, and not a
 * redirect of active work.
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

function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (const byte of Buffer.from(text, "utf8")) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16);
}

/**
 * Stable broadcast id: deterministic for an identical request (sender, exact
 * content, ordered instructions) and distinct for any difference. This is the
 * idempotency key for retry after partial failure or crash.
 */
export function createBroadcastId(input: CrewBroadcastInput): string {
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
	const digest = fnv1a(
		JSON.stringify({ senderName: input.senderName, content: input.content, instructions: [...instructions] }),
	);
	return `broadcast-${digest}`;
}

/**
 * Deterministic per-recipient item identity: a function of the broadcast id
 * and the recipient's canonical name only, so it is stable across retries and
 * independent of inbox sequence. A persisted item whose id matches this
 * identity counts as already-persisted on retry.
 */
export function createBroadcastRecipientItemId(broadcastId: string, recipientName: string): string {
	return `broadcast-${fnv1a(broadcastId)}-${fnv1a(recipientName)}`;
}

/** Derived crew origin for every recipient: from the manifest member, never from claimed input. */
export function deriveBroadcastOrigin(sender: CrewMember): CrewOrigin {
	return { kind: "crew", name: sender.name, role: sender.role };
}

/** Builds one validated broadcast payload with the derived crew origin; never adds a reply route. */
export function createBroadcastPayload(
	sender: CrewMember,
	input: Omit<CrewBroadcastInput, "senderName">,
	sentAt?: number,
): MessagePayload {
	const payload: MessagePayload = {
		content: input.content,
		origin: deriveBroadcastOrigin(sender),
		kind: "broadcast",
		...(sentAt === undefined ? {} : { sentAt }),
		...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
	};
	if (!isMessagePayload(payload)) throw new CrewBroadcastError("invalid-payload", "invalid crew broadcast message");
	return payload;
}

export interface BroadcastRecipient {
	readonly member: CrewMember;
	readonly itemId: string;
}

export type BuildBroadcastRecipientsResult =
	| { readonly ok: true; readonly recipients: readonly BroadcastRecipient[] }
	| { readonly ok: false; readonly code: "unknown-sender" | "no-recipients" };

/**
 * Manifest-order recipient snapshot excluding the sender by exact canonical
 * identity. Presence never changes recipients or order. A no-recipients
 * outcome means the caller must stop before any storage IO.
 */
export function buildBroadcastRecipients(
	manifest: CrewManifest,
	senderName: string,
	broadcastId: string,
): BuildBroadcastRecipientsResult {
	const sender = manifest.members.find((candidate) => candidate.name === senderName);
	if (!sender) return { ok: false, code: "unknown-sender" };
	const recipients = manifest.members
		.filter((member) => member.name !== sender.name)
		.map((member) => ({
			member,
			itemId: createBroadcastRecipientItemId(broadcastId, member.name),
		}));
	if (recipients.length === 0) return { ok: false, code: "no-recipients" };
	return { ok: true, recipients };
}

export interface BroadcastDisposition {
	readonly recipientName: string;
	readonly recipientRole: string;
	readonly itemId: string;
	readonly status: "persisted" | "already-persisted" | "failed";
	/** Stable failure code when status is "failed" (e.g. inbox-full, storage error). */
	readonly code?: string;
	readonly message?: string;
}

export interface BroadcastSummary {
	readonly persisted: number;
	readonly alreadyPersisted: number;
	readonly failed: number;
	readonly total: number;
}

/** Every target reports a disposition; partial failure is never masked as total success. */
export function summarizeBroadcastDispositions(dispositions: readonly BroadcastDisposition[]): BroadcastSummary {
	let persisted = 0;
	let alreadyPersisted = 0;
	let failed = 0;
	for (const disposition of dispositions) {
		if (disposition.status === "persisted") persisted += 1;
		else if (disposition.status === "already-persisted") alreadyPersisted += 1;
		else failed += 1;
	}
	return { persisted, alreadyPersisted, failed, total: dispositions.length };
}

/**
 * Fan-out outcome contract. An ok:false result (unknown sender or no
 * recipients after self exclusion) is decided before any storage IO; an
 * ok:true result reports the disposition of every target.
 */
export type CrewBroadcastResult =
	| {
			readonly ok: true;
			readonly broadcastId: string;
			readonly dispositions: readonly BroadcastDisposition[];
			readonly summary: BroadcastSummary;
	  }
	| { readonly ok: false; readonly code: "unknown-sender" | "no-recipients"; readonly broadcastId: string };

/** Composes an ok:false outcome with no storage IO involved. */
export function noRecipientsResult(broadcastId: string, code: "unknown-sender" | "no-recipients"): CrewBroadcastResult {
	return { ok: false, code, broadcastId };
}
