import { Type, type Static } from "@sinclair/typebox";
import { renderMessagePayload } from "./message-renderer.ts";
import type { MessagePayload } from "./message-payload.ts";

/**
 * TASK-0139: target-observed delivery provenance for a busy-target queued
 * Follow-up. Delivery order is not response causality: acceptance and
 * handoff times are target-local observations, never sender-authored time
 * and never authentication. The compact queue delay is computed once at
 * handoff and frozen; it never ages on rerender or reload.
 */

export const DeliveryProvenanceSchema = Type.Object(
	{
		deliveryId: Type.String({ minLength: 1 }),
		acceptedAt: Type.Number(),
		handoffAt: Type.Number(),
		queueDelay: Type.String({ minLength: 1 }),
		disposition: Type.Literal("queued"),
	},
	{ additionalProperties: false },
);
export type DeliveryProvenance = Static<typeof DeliveryProvenanceSchema>;

export function isDeliveryProvenance(value: unknown): value is DeliveryProvenance {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.deliveryId === "string" &&
		candidate.deliveryId.length > 0 &&
		typeof candidate.acceptedAt === "number" &&
		typeof candidate.handoffAt === "number" &&
		typeof candidate.queueDelay === "string" &&
		candidate.queueDelay.length > 0 &&
		candidate.disposition === "queued"
	);
}

export interface QueuedFollowUpAcceptance {
	readonly deliveryId: string;
	readonly acceptedAt: number;
}

export interface QueuedFollowUpClock {
	now(): number;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Deterministic compact queue delay from target acceptance to target
 * handoff. Floor-based unit boundaries (s/m/h/d), never negative: a clock
 * skew below zero clamps to "0s".
 */
export function formatQueueDelay(durationMs: number): string {
	const clamped = Math.max(0, Math.floor(durationMs));
	if (clamped < MINUTE) return `${Math.floor(clamped / SECOND)}s`;
	if (clamped < HOUR) return `${Math.floor(clamped / MINUTE)}m`;
	if (clamped < DAY) return `${Math.floor(clamped / HOUR)}h`;
	return `${Math.floor(clamped / DAY)}d`;
}

/**
 * Session-local acceptance registry. `record` is called by the target at
 * busy acceptance; `claimHandoff` is called exactly once when the queued
 * message is handed to the model. Handoff claiming is idempotent-once: a
 * second claim (rerender, replay, duplicate event) gets null and the
 * frozen provenance stays authoritative.
 */
export class QueuedFollowUpAcceptanceRegistry {
	private readonly clock: QueuedFollowUpClock;
	private readonly pending = new Map<string, QueuedFollowUpAcceptance>();

	constructor(clock: QueuedFollowUpClock) {
		this.clock = clock;
	}

	record(deliveryId: string): QueuedFollowUpAcceptance {
		const acceptance = { deliveryId, acceptedAt: this.clock.now() };
		this.pending.set(deliveryId, acceptance);
		return acceptance;
	}

	claimHandoff(deliveryId: string): DeliveryProvenance | null {
		const acceptance = this.pending.get(deliveryId);
		if (!acceptance) return null;
		this.pending.delete(deliveryId);
		const handoffAt = this.clock.now();
		return {
			deliveryId: acceptance.deliveryId,
			acceptedAt: acceptance.acceptedAt,
			handoffAt,
			queueDelay: formatQueueDelay(handoffAt - acceptance.acceptedAt),
			disposition: "queued",
		};
	}

	pendingCount(): number {
		return this.pending.size;
	}
}

/** Compact one-line label shared by model content and TUI (renderer parity). */
export function queuedFollowUpLabel(queueDelay: string): string {
	return `[follow-up · queued ${queueDelay} before delivery · uncorrelated]`;
}

/**
 * Model-visible content of a queued Follow-up at handoff: the immutable
 * compact label, uncorrelated + may-predate guidance, and exactly one
 * canonical payload. Never implies reply, completion, current state, or
 * task ownership; never carries raw timestamps, delivery IDs, or routing
 * internals (those stay structured-only in `details.deliveryProvenance`).
 */
export function renderQueuedFollowUpModelContent(payload: MessagePayload, provenance: DeliveryProvenance): string {
	const label = queuedFollowUpLabel(provenance.queueDelay);
	return (
		`${label} information only; no correlated Response expected. ` +
		"It was accepted while the target was busy and may predate newer coordination; " +
		"never infer response causality from arrival order — use send_member_request " +
		`when exactly one answer, report, verdict, or evidence response is required.\n${renderMessagePayload(payload)}`
	);
}
