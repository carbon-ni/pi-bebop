import { createHash } from "node:crypto";
import type { RetrospectiveEvidenceInterval } from "./retrospective-evidence.ts";

/** TASK-0115: deterministic assembly of the shared Crew Retrospective Record. */

export const CREW_RETROSPECTIVE_RECORD_VERSION = 1 as const;
export const MAX_RECORD_EVIDENCE_INDEX_ENTRIES = 512;
export const MAX_RECORD_SITUATIONS = 64;
export const MAX_SITUATION_SUMMARY_BYTES = 2048;
export const MAX_SITUATION_INTERPRETATION_BYTES = 2048;
export const MAX_SITUATION_CONTRIBUTORS = 16;
export const MAX_SITUATION_EVIDENCE_REFS = 32;
export const MAX_SITUATION_AGREEMENT_REFS = 8;
export const MAX_RECORD_ROSTER_MEMBERS = 32;
export const MAX_COLLECTOR_SNAPSHOT_ENTRIES = 16;
export const MAX_COLLECTOR_OUTCOME_BYTES = 256;
export const MAX_EVIDENCE_ID_BYTES = 128;
export const MAX_EVIDENCE_CANONICAL_BYTES = 128 * 1024;
export const MAX_SITUATION_ID_BYTES = 128;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export type CollectorAvailability = "captured" | "unavailable" | "unsupported";

export interface CollectorSnapshotEntry {
	readonly collector: string;
	readonly availability: CollectorAvailability;
	/** Bounded mechanical reason when not captured. */
	readonly outcome?: string;
}

export interface RecordEvidenceItem {
	readonly id: string;
	readonly fingerprint: string;
	/** Canonical evidence bytes; used to detect fingerprint conflicts. */
	readonly canonicalBytes: string;
	readonly sourceKind: string;
	readonly sourceIdentity: string;
	readonly sourceReference: string;
	readonly availability: string;
}

export interface EvidenceIndexEntry {
	readonly id: string;
	readonly fingerprint: string;
	/** sha256 of the evidence canonical bytes: covers semantic bytes without embedding them. */
	readonly canonicalDigest: string;
	readonly sourceKind: string;
	readonly sourceIdentity: string;
	readonly sourceReference: string;
	readonly availability: string;
	/** True when another entry shares the fingerprint with different canonical bytes. */
	readonly conflict: boolean;
}

export type NondeterminismLabel = "model" | "facilitator";

export interface SituationInterpretation {
	readonly text: string;
	readonly producer: string;
	readonly producerVersion: string;
	readonly nondeterminism: NondeterminismLabel;
}

export interface RetrospectiveSituationInput {
	readonly id: string;
	readonly contributors: readonly string[];
	/** Mandatory: at least one evidence reference that exists in the index. */
	readonly evidenceIds: readonly string[];
	readonly factualSummary: string;
	readonly interpretation?: SituationInterpretation;
	readonly agreementRefs?: readonly string[];
	readonly disputeWith?: readonly string[];
}

export interface RetrospectiveSituation extends RetrospectiveSituationInput {
	readonly interpretation?: SituationInterpretation;
	readonly agreementRefs: readonly string[];
	readonly disputeWith: readonly string[];
}

export interface AssemblyInput {
	readonly retrospectiveId: string;
	readonly interval: RetrospectiveEvidenceInterval;
	readonly roster: readonly string[];
	readonly collectors: readonly CollectorSnapshotEntry[];
	readonly evidence: readonly RecordEvidenceItem[];
	readonly situations: readonly RetrospectiveSituationInput[];
}

export interface CrewRetrospectiveRecord {
	readonly version: typeof CREW_RETROSPECTIVE_RECORD_VERSION;
	readonly kind: "crew-retrospective-record";
	readonly id: string;
	readonly retrospectiveId: string;
	readonly interval: RetrospectiveEvidenceInterval;
	readonly roster: readonly string[];
	readonly collectors: readonly CollectorSnapshotEntry[];
	readonly evidenceIndex: readonly EvidenceIndexEntry[];
	readonly omittedEvidenceCount: number;
	readonly situations: readonly RetrospectiveSituation[];
	readonly omittedSituationCount: number;
	readonly contentHash: string;
}

export class RetrospectiveRecordAssemblyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetrospectiveRecordAssemblyError";
	}
}

function fnv1a32(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function safeSegment(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
	return cleaned.length > 0 ? cleaned : "unknown";
}

export function retrospectiveRecordId(retrospectiveId: string, interval: RetrospectiveEvidenceInterval): string {
	const intervalKey = fnv1a32(`${interval.start}|${interval.end}`);
	return `retro-record.${safeSegment(retrospectiveId)}.${intervalKey}`;
}

export function canonicalRetrospectiveRecordJson(value: unknown): string {
	return JSON.stringify(sortValueLeaves(value));
}

function sortValueLeaves(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValueLeaves).sort(compareCanonicalText);
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			result[key] = sortValueLeaves(record[key]);
		}
		return result;
	}
	return value;
}

function compareCanonicalText(a: unknown, b: unknown): number {
	return canonicalPrimitive(a).localeCompare(canonicalPrimitive(b));
}

function canonicalPrimitive(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

export function retrospectiveRecordContentHash(recordWithoutHash: unknown): string {
	return createHash("sha256").update(canonicalRetrospectiveRecordJson(recordWithoutHash), "utf8").digest("hex");
}

const CREDENTIAL_PATTERN = /(api[_-]?key|token|secret|password|credential)\s*[=:]\s*\S+/i;

function assertNoCredentialLeak(text: string, label: string): void {
	if (CREDENTIAL_PATTERN.test(text)) {
		throw new RetrospectiveRecordAssemblyError(`${label} contains unredacted credential-like content`);
	}
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function validateInterval(interval: RetrospectiveEvidenceInterval): void {
	if (!interval.start || !interval.end || interval.end <= interval.start) {
		throw new RetrospectiveRecordAssemblyError("interval must satisfy start < end");
	}
}

function validateRoster(roster: readonly string[]): void {
	if (roster.length === 0) throw new RetrospectiveRecordAssemblyError("roster must not be empty");
	if (roster.length > MAX_RECORD_ROSTER_MEMBERS)
		throw new RetrospectiveRecordAssemblyError(`roster exceeds ${MAX_RECORD_ROSTER_MEMBERS} members`);
	const seen = new Set<string>();
	for (const member of roster) {
		if (member.length === 0) throw new RetrospectiveRecordAssemblyError("roster member name must be non-empty");
		if (seen.has(member)) throw new RetrospectiveRecordAssemblyError(`duplicate roster member: ${member}`);
		seen.add(member);
	}
}

function validateCollectors(collectors: readonly CollectorSnapshotEntry[]): readonly CollectorSnapshotEntry[] {
	if (collectors.length > MAX_COLLECTOR_SNAPSHOT_ENTRIES)
		throw new RetrospectiveRecordAssemblyError(
			`collector snapshot exceeds ${MAX_COLLECTOR_SNAPSHOT_ENTRIES} entries`,
		);
	return collectors.map((entry) => {
		if (!entry.collector || entry.collector.length === 0)
			throw new RetrospectiveRecordAssemblyError("collector name must be non-empty");
		if (entry.outcome !== undefined && byteLength(entry.outcome) > MAX_COLLECTOR_OUTCOME_BYTES)
			throw new RetrospectiveRecordAssemblyError("collector outcome exceeds byte bound");
		return entry.outcome === undefined ? entry : entry;
	});
}

function validateEvidenceItem(item: RecordEvidenceItem): void {
	if (!ID_PATTERN.test(item.id) || byteLength(item.id) > MAX_EVIDENCE_ID_BYTES)
		throw new RetrospectiveRecordAssemblyError(`evidence id is invalid: ${item.id}`);
	if (!FINGERPRINT_PATTERN.test(item.fingerprint))
		throw new RetrospectiveRecordAssemblyError(`evidence fingerprint must be 64-char hex: ${item.id}`);
	if (byteLength(item.canonicalBytes) > MAX_EVIDENCE_CANONICAL_BYTES)
		throw new RetrospectiveRecordAssemblyError(`evidence canonical bytes exceed bound: ${item.id}`);
	if (!item.sourceKind || !item.sourceIdentity || !item.sourceReference)
		throw new RetrospectiveRecordAssemblyError(`evidence source fields must be non-empty: ${item.id}`);
}

function buildEvidenceIndex(evidence: readonly RecordEvidenceItem[]): {
	index: readonly EvidenceIndexEntry[];
	omittedCount: number;
} {
	const validated = [...evidence];
	for (const item of validated) validateEvidenceItem(item);

	// Deterministic order first, so overflow subsets are stable.
	validated.sort(
		(left, right) =>
			left.sourceKind.localeCompare(right.sourceKind) ||
			left.id.localeCompare(right.id) ||
			left.fingerprint.localeCompare(right.fingerprint),
	);

	// Fingerprint dedup: identical canonical bytes collapse; same fingerprint
	// with different canonical bytes stays side-by-side as explicit conflict.
	const byFingerprint = new Map<string, RecordEvidenceItem[]>();
	for (const item of validated) {
		const group = byFingerprint.get(item.fingerprint) ?? [];
		if (!group.some((entry) => entry.canonicalBytes === item.canonicalBytes && entry.id === item.id)) {
			group.push(item);
		}
		byFingerprint.set(item.fingerprint, group);
	}

	const kept: RecordEvidenceItem[] = [];
	for (const item of validated) {
		const group = byFingerprint.get(item.fingerprint)!;
		const canonicalDuplicates = group.filter((entry) => entry.canonicalBytes === item.canonicalBytes);
		const isFirstOfCanonical = canonicalDuplicates[0] === item;
		if (isFirstOfCanonical) kept.push(item);
	}

	const conflictFingerprints = new Set(
		[...byFingerprint.entries()]
			.filter(([, group]) => new Set(group.map((entry) => entry.canonicalBytes)).size > 1)
			.map(([fingerprint]) => fingerprint),
	);

	const omittedCount = Math.max(0, kept.length - MAX_RECORD_EVIDENCE_INDEX_ENTRIES);
	const bounded = kept.slice(0, MAX_RECORD_EVIDENCE_INDEX_ENTRIES);
	const index: EvidenceIndexEntry[] = bounded.map((item) => ({
		id: item.id,
		fingerprint: item.fingerprint,
		canonicalDigest: createHash("sha256").update(item.canonicalBytes, "utf8").digest("hex"),
		sourceKind: item.sourceKind,
		sourceIdentity: item.sourceIdentity,
		sourceReference: item.sourceReference,
		availability: item.availability,
		conflict: conflictFingerprints.has(item.fingerprint),
	}));
	return { index, omittedCount };
}

function validateSituationInterpretation(situation: RetrospectiveSituationInput): void {
	const interpretation = situation.interpretation;
	if (interpretation === undefined) return;
	if (interpretation.text.length === 0 || byteLength(interpretation.text) > MAX_SITUATION_INTERPRETATION_BYTES)
		throw new RetrospectiveRecordAssemblyError(`situation ${situation.id} interpretation exceeds bound`);
	if (!interpretation.producer || !interpretation.producerVersion || !interpretation.nondeterminism)
		throw new RetrospectiveRecordAssemblyError(
			`situation ${situation.id} interpretation needs producer/version/nondeterminism`,
		);
	assertNoCredentialLeak(interpretation.text, `situation ${situation.id} interpretation`);
}

function validateSituation(
	situation: RetrospectiveSituationInput,
	knownEvidence: ReadonlySet<string>,
): RetrospectiveSituation {
	if (!ID_PATTERN.test(situation.id) || byteLength(situation.id) > MAX_SITUATION_ID_BYTES)
		throw new RetrospectiveRecordAssemblyError(`situation id is invalid: ${situation.id}`);
	if (situation.contributors.length === 0 || situation.contributors.length > MAX_SITUATION_CONTRIBUTORS)
		throw new RetrospectiveRecordAssemblyError(
			`situation ${situation.id} needs 1..${MAX_SITUATION_CONTRIBUTORS} contributors`,
		);
	if (situation.evidenceIds.length === 0 || situation.evidenceIds.length > MAX_SITUATION_EVIDENCE_REFS)
		throw new RetrospectiveRecordAssemblyError(
			`situation ${situation.id} requires 1..${MAX_SITUATION_EVIDENCE_REFS} evidence references`,
		);
	for (const evidenceId of situation.evidenceIds) {
		if (!knownEvidence.has(evidenceId))
			throw new RetrospectiveRecordAssemblyError(
				`situation ${situation.id} references unknown evidence: ${evidenceId}`,
			);
	}
	if (situation.factualSummary.length === 0 || byteLength(situation.factualSummary) > MAX_SITUATION_SUMMARY_BYTES)
		throw new RetrospectiveRecordAssemblyError(`situation ${situation.id} summary exceeds bound`);
	assertNoCredentialLeak(situation.factualSummary, `situation ${situation.id} summary`);
	validateSituationInterpretation(situation);
	if (situation.agreementRefs !== undefined && situation.agreementRefs.length > MAX_SITUATION_AGREEMENT_REFS)
		throw new RetrospectiveRecordAssemblyError(`situation ${situation.id} agreement refs exceed bound`);
	return {
		...situation,
		agreementRefs: situation.agreementRefs ?? [],
		disputeWith: situation.disputeWith ?? [],
	};
}

function buildSituations(
	situations: readonly RetrospectiveSituationInput[],
	knownEvidence: ReadonlySet<string>,
): { kept: readonly RetrospectiveSituation[]; omittedCount: number } {
	const seen = new Set<string>();
	for (const situation of situations) {
		if (seen.has(situation.id))
			throw new RetrospectiveRecordAssemblyError(`duplicate situation id: ${situation.id}`);
		seen.add(situation.id);
	}
	const validated = situations.map((situation) => validateSituation(situation, knownEvidence));
	// Deterministic order by id for stable overflow subsets.
	validated.sort((left, right) => left.id.localeCompare(right.id));
	const situationIds = new Set(validated.map((situation) => situation.id));
	for (const situation of validated) {
		for (const disputed of situation.disputeWith) {
			if (!situationIds.has(disputed))
				throw new RetrospectiveRecordAssemblyError(
					`situation ${situation.id} disputes unknown situation: ${disputed}`,
				);
		}
	}
	const omittedCount = Math.max(0, validated.length - MAX_RECORD_SITUATIONS);
	return { kept: validated.slice(0, MAX_RECORD_SITUATIONS), omittedCount };
}

/** Pure deterministic assembly: same inputs always produce byte-identical record bytes. */
export function assembleCrewRetrospectiveRecord(input: AssemblyInput): CrewRetrospectiveRecord {
	validateInterval(input.interval);
	validateRoster(input.roster);
	const collectors = validateCollectors(input.collectors);
	const { index, omittedCount } = buildEvidenceIndex(input.evidence);
	const knownEvidence = new Set(index.map((entry) => entry.id));
	const { kept: situations, omittedCount: omittedSituationCount } = buildSituations(input.situations, knownEvidence);

	const id = retrospectiveRecordId(input.retrospectiveId, input.interval);
	const preHash: Omit<CrewRetrospectiveRecord, "contentHash"> = {
		version: CREW_RETROSPECTIVE_RECORD_VERSION,
		kind: "crew-retrospective-record",
		id,
		retrospectiveId: input.retrospectiveId,
		interval: input.interval,
		roster: input.roster,
		collectors,
		evidenceIndex: index,
		omittedEvidenceCount: omittedCount,
		situations,
		omittedSituationCount,
	};
	return { ...preHash, contentHash: retrospectiveRecordContentHash(preHash) };
}

export function isCrewRetrospectiveRecord(value: unknown): value is CrewRetrospectiveRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === CREW_RETROSPECTIVE_RECORD_VERSION &&
		record.kind === "crew-retrospective-record" &&
		typeof record.id === "string" &&
		typeof record.contentHash === "string" &&
		FINGERPRINT_PATTERN.test(record.contentHash)
	);
}
