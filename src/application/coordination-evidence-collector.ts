import {
	type CoordinationEvent,
	type CoordinationEventFamily,
	type CoordinationMechanicalContext,
	type CoordinationOutcomeKind,
	coordinationEvidenceId,
	coordinationSourceIdentity,
	coordinationSourceReference,
	boundContentSummary,
	isMechanicalContextOnly,
} from "../domain/coordination-evidence.ts";
import {
	type RetrospectiveEvidenceInput,
	type RetrospectiveEvidenceInterval,
	type RetrospectiveEvidence,
	createRetrospectiveEvidence,
	type RetrospectiveEvidenceFingerprint,
	canonicalRetrospectiveEvidenceFingerprintInput,
} from "../domain/index.ts";

/** Collector identity used in capture provenance. */
export const COORDINATION_COLLECTOR_ID = "bebop.coordination-collector";

/**
 * Maps a CoordinationEvent to a RetrospectiveEvidenceInput for a given interval.
 * Read-only: never sends messages, changes Inbox state, or activates Agreements.
 */
export function coordinationEventToEvidenceInput(
	event: CoordinationEvent,
	interval: RetrospectiveEvidenceInterval,
): RetrospectiveEvidenceInput {
	const occurredAt = event.occurredAt;
	const startsBeforeInterval = occurredAt < interval.start;
	const startsAtOrAfterEnd = occurredAt >= interval.end;
	if (startsBeforeInterval || startsAtOrAfterEnd) {
		throw new Error(`coordination event at ${occurredAt} is outside interval [${interval.start}, ${interval.end})`);
	}
	if (event.context && !isMechanicalContextOnly(event.context)) {
		throw new Error("coordination event mechanical context contains non-mechanical fields");
	}

	const summaryText = event.contentSummary ?? event.outcome;
	const representation = { kind: "content" as const, text: boundContentSummary(summaryText) };

	const id = event.correlationId
		? coordinationEvidenceId(event.source.family, event.correlationId, event.outcome)
		: coordinationEvidenceId(event.source.family, event.source.identity, event.outcome);

	// capturedAt is anchored to the event occurrence so repeated collection of the
	// same event is byte-identical (idempotent replay + fingerprint dedup).
	// No ambient clock dependence.
	return {
		id,
		interval,
		source: {
			kind: "bebop-coordination",
			identity: coordinationSourceIdentity(event.source.family, event.source.identity),
			reference: coordinationSourceReference(event.source.family, event.source.identity, event.outcome),
		},
		availability: "captured",
		representation,
		capture: {
			capturedAt: event.occurredAt,
			collector: COORDINATION_COLLECTOR_ID,
			provenance: `bebop-coordination.${event.source.family}.${event.outcome}`,
		},
	};
}

/**
 * Collects coordination evidence for an exact interval.
 * Returns ordered, deduplicated evidence items.
 * Collection is read-only and idempotent for identical events.
 */
export interface CoordinationCollectorResult {
	readonly items: readonly RetrospectiveEvidence[];
	readonly rejected: readonly { event: CoordinationEvent; reason: string }[];
}

export function collectCoordinationEvidence(
	events: readonly CoordinationEvent[],
	interval: RetrospectiveEvidenceInterval,
	fingerprint: RetrospectiveEvidenceFingerprint,
): CoordinationCollectorResult {
	const accepted: RetrospectiveEvidence[] = [];
	const rejected: { event: CoordinationEvent; reason: string }[] = [];

	for (const event of events) {
		try {
			const input = coordinationEventToEvidenceInput(event, interval);
			const evidence = createRetrospectiveEvidence(input, fingerprint);
			accepted.push(evidence);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			rejected.push({ event, reason });
		}
	}

	return { items: accepted, rejected };
}

/**
 * Reports missing, corrupt, rotated, or unavailable coordination sources.
 * Returns a gap evidence input for each unavailable source.
 */
export function coordinationSourceGap(
	family: CoordinationEventFamily,
	identity: string,
	reason: string,
	interval: RetrospectiveEvidenceInterval,
	capturedAt: string,
): RetrospectiveEvidenceInput {
	const safeReason = reason.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 20) || "unknown";
	const id = `${family}.${identity}.unavailable.${safeReason}`;
	return {
		id,
		interval,
		source: {
			kind: "bebop-coordination",
			identity: coordinationSourceIdentity(family, identity),
			reference: `${coordinationSourceIdentity(family, identity)}.unavailable`,
		},
		availability: "unavailable",
		gap: { reason: boundContentSummary(reason) },
		capture: {
			capturedAt,
			collector: COORDINATION_COLLECTOR_ID,
			provenance: `bebop-coordination.${family}.unavailable`,
		},
	};
}

/**
 * Creates a "captured" evidence record from a coordination event.
 * Convenience wrapper for single-event collection.
 */
export function collectSingleCoordinationEvent(
	event: CoordinationEvent,
	interval: RetrospectiveEvidenceInterval,
	fingerprint: RetrospectiveEvidenceFingerprint,
): RetrospectiveEvidence {
	const input = coordinationEventToEvidenceInput(event, interval);
	return createRetrospectiveEvidence(input, fingerprint);
}

/**
 * Read-only finite source seam. Each source provides coordination events
 * for a specific family. Sources never send messages, mutate Inbox, or
 * activate Agreements — they only return event arrays.
 */
export interface CoordinationEventSource {
	readonly family: CoordinationEventFamily;
	readonly identity: string;
	/** Collect events for the exact interval. Must be finite and read-only. */
	collect(interval: RetrospectiveEvidenceInterval): readonly CoordinationEvent[];
}

export interface CollectFromSourcesResult {
	readonly items: readonly RetrospectiveEvidence[];
	readonly rejected: readonly { event: CoordinationEvent; reason: string }[];
	readonly gaps: readonly RetrospectiveEvidence[];
}

/**
 * Collects coordination evidence from multiple injected sources.
 * Source errors become explicit gap evidence rather than silent failures.
 * Read-only: never mutates sources, sends messages, or activates Agreements.
 */
export function collectFromSources(
	sources: readonly CoordinationEventSource[],
	interval: RetrospectiveEvidenceInterval,
	fingerprint: RetrospectiveEvidenceFingerprint,
): CollectFromSourcesResult {
	const allItems: RetrospectiveEvidence[] = [];
	const allRejected: { event: CoordinationEvent; reason: string }[] = [];
	const gaps: RetrospectiveEvidence[] = [];

	for (const source of sources) {
		let events: readonly CoordinationEvent[];
		try {
			events = source.collect(interval);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			try {
				// Gap capture anchored to interval start for deterministic replay.
				const gapInput = coordinationSourceGap(
					source.family,
					source.identity,
					reason,
					interval,
					interval.start,
				);
				gaps.push(createRetrospectiveEvidence(gapInput, fingerprint));
			} catch {
				// Gap creation itself failed; skip silently to avoid cascading errors.
			}
			continue;
		}

		const result = collectCoordinationEvidence(events, interval, fingerprint);
		allItems.push(...result.items);
		allRejected.push(...result.rejected);
	}

	return { items: allItems, rejected: allRejected, gaps };
}
