import type { RetrospectiveEvidenceStore } from "../infra/retrospective-evidence-store.ts";
import { canonicalRetrospectiveEvidenceJson } from "../domain/index.ts";
import {
	assembleCrewRetrospectiveRecord,
	type CrewRetrospectiveRecord,
	type RetrospectiveSituationInput,
	type CollectorSnapshotEntry,
} from "../domain/retrospective-record.ts";
import type { RetrospectiveEvidenceInterval } from "../domain/retrospective-evidence.ts";

/** TASK-0115: read-only synthesis of collected evidence into the shared record. */

export interface RetrospectiveRecordAssemblyOutcome {
	readonly record: CrewRetrospectiveRecord;
	/** Evidence outside the exact interval: belongs to the next interval, never silently added. */
	readonly excludedEvidenceIds: readonly string[];
}

export interface RetrospectiveRecordAssemblyRequest {
	readonly retrospectiveId: string;
	readonly interval: RetrospectiveEvidenceInterval;
	readonly roster: readonly string[];
	readonly collectors: readonly CollectorSnapshotEntry[];
	readonly situations: readonly RetrospectiveSituationInput[];
	/** TASK-0111 trusted evidence store; read-only usage (list only). */
	readonly evidenceStore: RetrospectiveEvidenceStore;
}

/**
 * Assembles the Crew Retrospective Record from the trusted evidence store.
 * Read-only: reads evidence via list(), never writes, sends, or activates.
 * Evidence outside the exact interval is excluded explicitly (late evidence
 * belongs to the next interval).
 */
export async function assembleRetrospectiveRecordFromStore(
	request: RetrospectiveRecordAssemblyRequest,
): Promise<RetrospectiveRecordAssemblyOutcome> {
	const allEvidence = await request.evidenceStore.list();
	const excludedEvidenceIds: string[] = [];
	const inInterval = allEvidence.filter((item) => {
		if (item.interval.start === request.interval.start && item.interval.end === request.interval.end) {
			return true;
		}
		excludedEvidenceIds.push(item.id);
		return false;
	});

	const record = assembleCrewRetrospectiveRecord({
		retrospectiveId: request.retrospectiveId,
		interval: request.interval,
		roster: request.roster,
		collectors: request.collectors,
		evidence: inInterval.map((item) => ({
			id: item.id,
			fingerprint: item.fingerprint,
			canonicalBytes: canonicalRetrospectiveEvidenceJson(item),
			sourceKind: item.source.kind,
			sourceIdentity: item.source.identity,
			sourceReference: item.source.reference,
			availability: item.availability,
		})),
		situations: request.situations,
	});

	return { record, excludedEvidenceIds };
}
