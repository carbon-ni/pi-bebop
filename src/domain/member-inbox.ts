import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isMessagePayload, MessagePayloadSchema, type MessagePayload } from "./message-payload.ts";

/**
 * Durable member inbox semantics (domain contract).
 *
 * An inbox is a transport mechanism, never a workflow engine: it stores one
 * ordinary structured `MessagePayload` per item for a configured member until
 * Pi can accept it as a non-interrupting follow-up. Item content is opaque —
 * the inbox never detects tasks, plans, Git state, review state, or branches.
 *
 * Lifecycle: persist message -> notify recipient best-effort -> offer one item
 * as a Pi follow-up -> remove after durable session evidence. Offering always
 * goes through normal Pi follow-up semantics, so follow-ups already accepted
 * by Pi keep FIFO precedence without any separate priority scheduler.
 *
 * Acceptance means durably persisted — never delivered, started, completed, or
 * answered. Crash deduplication is bounded: a stable item id plus recorded
 * recipient session evidence lets restart skip items already handed into a
 * session; no exactly-once delivery is claimed beyond that boundary.
 *
 * Any joined member may enqueue; claimed role names grant no permission (the
 * permission boundary lives in the application layer, not here).
 */

export const INBOX_VERSION = 1 as const;
export const MAX_INBOX_ITEMS = 64;
export const MAX_INBOX_ID_BYTES = 128;
export const MAX_INBOX_TARGET_FIELD_BYTES = 256;

const NonEmptyText = Type.String({ minLength: 1 });
export const InboxTargetSchema = Type.Object(
	{ name: NonEmptyText, socketPath: NonEmptyText },
	{ additionalProperties: false },
);
export const InboxItemSchema = Type.Object(
	{
		version: Type.Literal(INBOX_VERSION),
		id: NonEmptyText,
		target: InboxTargetSchema,
		payload: MessagePayloadSchema,
		enqueuedAt: Type.Number(),
		sequence: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export const MemberInboxSchema = Type.Object(
	{
		version: Type.Literal(INBOX_VERSION),
		target: InboxTargetSchema,
		offering: Type.Union([Type.Literal("active"), Type.Literal("paused")]),
		items: Type.Array(InboxItemSchema, { maxItems: MAX_INBOX_ITEMS }),
	},
	{ additionalProperties: false },
);

export type InboxTarget = Static<typeof InboxTargetSchema>;
export type InboxItem = Static<typeof InboxItemSchema>;
export type MemberInbox = Static<typeof MemberInboxSchema>;
export type InboxOffering = MemberInbox["offering"];

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const invalidTextField = (value: string, limit: number): boolean =>
	value.trim().length === 0 || value !== value.trim() || value.includes("\0") || utf8Bytes(value) > limit;

function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (const byte of Buffer.from(text, "utf8")) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16);
}

/** Deterministic item id: same target, sequence, and payload always produce the same id. */
export function createInboxItemId(target: InboxTarget, sequence: number, payload: MessagePayload): string {
	return `inbox-${sequence.toString(16)}-${fnv1a(JSON.stringify({ target, sequence, payload }))}`;
}

export function isInboxTarget(value: unknown): value is InboxTarget {
	if (!Value.Check(InboxTargetSchema, value)) return false;
	const target = value as InboxTarget;
	return ![target.name, target.socketPath].some((field) => invalidTextField(field, MAX_INBOX_TARGET_FIELD_BYTES));
}

export function isInboxItem(value: unknown): value is InboxItem {
	if (!Value.Check(InboxItemSchema, value)) return false;
	const item = value as InboxItem;
	if (invalidTextField(item.id, MAX_INBOX_ID_BYTES)) return false;
	if (!isInboxTarget(item.target)) return false;
	if (!Number.isFinite(item.enqueuedAt) || item.enqueuedAt < 0) return false;
	return isMessagePayload(item.payload);
}

export function isMemberInbox(value: unknown): value is MemberInbox {
	if (!Value.Check(MemberInboxSchema, value)) return false;
	const inbox = value as MemberInbox;
	if (!isInboxTarget(inbox.target)) return false;
	const ids = new Set<string>();
	const sequences = new Set<number>();
	for (const item of inbox.items) {
		if (!isInboxItem(item)) return false;
		if (item.target.name !== inbox.target.name || item.target.socketPath !== inbox.target.socketPath) return false;
		if (ids.has(item.id)) return false;
		if (sequences.has(item.sequence)) return false;
		ids.add(item.id);
		sequences.add(item.sequence);
	}
	return true;
}

export function createMemberInbox(target: InboxTarget): MemberInbox {
	if (!isInboxTarget(target)) throw new TypeError("inbox target must be a non-empty name and socket path");
	return { version: INBOX_VERSION, target, offering: "active", items: [] };
}

/** Next deterministic sequence: strictly greater than every stored sequence and the optional floor. */
export function nextInboxSequence(items: readonly InboxItem[], floor = 0): number {
	let next = floor;
	for (const item of items) if (item.sequence + 1 > next) next = item.sequence + 1;
	return next;
}

/** FIFO ordering: sequence is unique per inbox, so timestamps never decide order. */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
	return a.sequence - b.sequence;
}

export type EnqueueInboxResult =
	| { readonly ok: true; readonly inbox: MemberInbox; readonly item: InboxItem }
	| { readonly ok: false; readonly code: "capacity-exceeded" | "invalid-payload"; readonly inbox: MemberInbox };

export function enqueueInboxItem(
	inbox: MemberInbox,
	request: { readonly payload: MessagePayload; readonly now: number },
): EnqueueInboxResult {
	if (!isMessagePayload(request.payload)) return { ok: false, code: "invalid-payload", inbox };
	if (inbox.items.length >= MAX_INBOX_ITEMS) return { ok: false, code: "capacity-exceeded", inbox };
	const sequence = nextInboxSequence(inbox.items);
	const item: InboxItem = {
		version: INBOX_VERSION,
		id: createInboxItemId(inbox.target, sequence, request.payload),
		target: inbox.target,
		payload: request.payload,
		enqueuedAt: request.now,
		sequence,
	};
	return { ok: true, inbox: { ...inbox, items: [...inbox.items, item] }, item };
}

export type CancelInboxResult =
	| { readonly ok: true; readonly inbox: MemberInbox }
	| { readonly ok: false; readonly code: "item-not-found"; readonly inbox: MemberInbox };

export function cancelInboxItem(inbox: MemberInbox, id: string): CancelInboxResult {
	const remaining = inbox.items.filter((item) => item.id !== id);
	if (remaining.length === inbox.items.length) return { ok: false, code: "item-not-found", inbox };
	return { ok: true, inbox: { ...inbox, items: remaining } };
}

export function setInboxOffering(inbox: MemberInbox, offering: InboxOffering): MemberInbox {
	return offering === inbox.offering ? inbox : { ...inbox, offering };
}

/** At most one pending item is offered at a time, earliest sequence first; pause stops offering. */
export function nextOfferableInboxItem(inbox: MemberInbox): InboxItem | null {
	if (inbox.offering !== "active" || inbox.items.length === 0) return null;
	return [...inbox.items].sort(compareInboxItems)[0] ?? null;
}

/** Bounded crash dedup: after a restart, only items without recorded acceptance evidence are pending. */
export function pendingInboxItemsAfterRestart(
	inbox: MemberInbox,
	acceptedItemIds: readonly string[],
): readonly InboxItem[] {
	const accepted = new Set(acceptedItemIds);
	return inbox.items.filter((item) => !accepted.has(item.id));
}

export interface InboxHandoffEvidence {
	readonly recipientSessionId: string;
	readonly itemIds: readonly string[];
}

export type RemoveAcknowledgedResult =
	| { readonly ok: true; readonly inbox: MemberInbox; readonly removedIds: readonly string[] }
	| { readonly ok: false; readonly code: "invalid-evidence"; readonly inbox: MemberInbox };

const invalidEvidence = (evidence: InboxHandoffEvidence): boolean =>
	invalidTextField(evidence.recipientSessionId, MAX_INBOX_TARGET_FIELD_BYTES) ||
	evidence.itemIds.length === 0 ||
	evidence.itemIds.some((id) => invalidTextField(id, MAX_INBOX_ID_BYTES));

/** Remove items only after durable recipient session evidence; unknown ids are ignored (idempotent). */
export function removeAcknowledgedInboxItems(
	inbox: MemberInbox,
	evidence: InboxHandoffEvidence,
): RemoveAcknowledgedResult {
	if (invalidEvidence(evidence)) return { ok: false, code: "invalid-evidence", inbox };
	const acknowledged = new Set(evidence.itemIds);
	const removedIds = inbox.items.filter((item) => acknowledged.has(item.id)).map((item) => item.id);
	if (removedIds.length === 0) return { ok: true, inbox, removedIds };
	const remaining = inbox.items.filter((item) => !acknowledged.has(item.id));
	return { ok: true, inbox: { ...inbox, items: remaining }, removedIds };
}
