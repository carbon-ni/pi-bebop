import { canonicalMessageLogJson } from "./message-log-entry.ts";

const MARKER_KINDS = [
	"epoch-open",
	"coverage-checkpoint",
	"epoch-clean-close",
	"capture-gap",
	"unverified-capture",
	"retention-gap",
] as const;
export type MessageLogMarkerKind = (typeof MARKER_KINDS)[number];
export type MessageLogMarker = Readonly<{
	version: 1;
	kind: MessageLogMarkerKind;
	id: string;
	occurredAt: string;
	endpointId: string | null;
	epochId: string | null;
	attemptSequence: number | null;
	details: Readonly<Record<string, unknown>>;
	semanticFingerprint: string;
}>;

const TOP_LEVEL_KEYS = [
	"version",
	"kind",
	"id",
	"occurredAt",
	"endpointId",
	"epochId",
	"attemptSequence",
	"details",
	"semanticFingerprint",
];
const MARKER_ID = /^marker-[0-9a-f]{64}$/;
const ENDPOINT_ID = /^endpoint-[0-9a-f]{64}$/;
const EPOCH_ID = /^epoch-[0-9a-f]{64}$/;
const GAP_CAUSES = [
	"store-unavailable",
	"lock-conflict",
	"write-failed",
	"id-conflict",
	"invalid-capture",
	"capture-capacity",
	"details-truncated",
] as const;
const RETENTION_REASONS = ["age", "capacity", "corruption"] as const;
type UnknownRecord = Record<string, unknown>;

function timestamp(value: unknown): boolean {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const parsed = new Date(value);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
function markerIdOrNull(value: unknown): boolean {
	return value === null || (typeof value === "string" && MARKER_ID.test(value));
}
function epochIdOrNull(value: unknown): boolean {
	return value === null || (typeof value === "string" && EPOCH_ID.test(value));
}
function safePositive(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}
function safeNonNegativeOrNull(value: unknown): boolean {
	return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}
function interval(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as UnknownRecord;
	return exactKeys(candidate, ["start", "end"]) && timestamp(candidate.start) && timestamp(candidate.end);
}
function validEpochOpen(value: UnknownRecord): boolean {
	return (
		exactKeys(value, ["openedAt", "priorMarkerId"]) &&
		timestamp(value.openedAt) &&
		markerIdOrNull(value.priorMarkerId)
	);
}
function validCheckpoint(value: UnknownRecord): boolean {
	return (
		exactKeys(value, ["intervalEnd", "lastAttemptSequence"]) &&
		timestamp(value.intervalEnd) &&
		safePositive(value.lastAttemptSequence)
	);
}
function validClose(value: UnknownRecord): boolean {
	return (
		exactKeys(value, ["closedAt", "lastAttemptSequence"]) &&
		timestamp(value.closedAt) &&
		safePositive(value.lastAttemptSequence)
	);
}
function validCaptureGap(value: UnknownRecord): boolean {
	return (
		exactKeys(value, [
			"cause",
			"firstSequence",
			"lastSequence",
			"firstOccurredAt",
			"lastOccurredAt",
			"attemptCount",
		]) &&
		typeof value.cause === "string" &&
		(GAP_CAUSES as readonly string[]).includes(value.cause) &&
		safePositive(value.firstSequence) &&
		safePositive(value.lastSequence) &&
		timestamp(value.firstOccurredAt) &&
		timestamp(value.lastOccurredAt) &&
		safePositive(value.attemptCount)
	);
}
function validUnverifiedCapture(value: UnknownRecord): boolean {
	return (
		exactKeys(value, ["priorEpochId", "priorMarkerId", "interval", "eventCount"]) &&
		epochIdOrNull(value.priorEpochId) &&
		markerIdOrNull(value.priorMarkerId) &&
		interval(value.interval) &&
		value.eventCount === null
	);
}
function validRetentionGap(value: UnknownRecord): boolean {
	return (
		exactKeys(value, ["interval", "removedEventCount", "removedCanonicalBytes", "reason", "detailsTruncated"]) &&
		interval(value.interval) &&
		safeNonNegativeOrNull(value.removedEventCount) &&
		safeNonNegativeOrNull(value.removedCanonicalBytes) &&
		typeof value.reason === "string" &&
		(RETENTION_REASONS as readonly string[]).includes(value.reason) &&
		typeof value.detailsTruncated === "boolean"
	);
}
function detailsShape(marker: MessageLogMarker): boolean {
	if (!marker.details || typeof marker.details !== "object" || Array.isArray(marker.details)) return false;
	const value = marker.details as UnknownRecord;
	switch (marker.kind) {
		case "epoch-open":
			return validEpochOpen(value);
		case "coverage-checkpoint":
			return validCheckpoint(value);
		case "epoch-clean-close":
			return validClose(value);
		case "capture-gap":
			return validCaptureGap(value);
		case "unverified-capture":
			return validUnverifiedCapture(value);
		case "retention-gap":
			return validRetentionGap(value);
	}
}
function validIdentity(marker: MessageLogMarker, retention: boolean): boolean {
	if (retention) return marker.endpointId === null && marker.epochId === null && marker.attemptSequence === null;
	return (
		typeof marker.endpointId === "string" &&
		ENDPOINT_ID.test(marker.endpointId) &&
		typeof marker.epochId === "string" &&
		EPOCH_ID.test(marker.epochId) &&
		safePositive(marker.attemptSequence)
	);
}
function validMarker(marker: MessageLogMarker): boolean {
	if (
		!marker ||
		typeof marker !== "object" ||
		Object.keys(marker).some((key) => !TOP_LEVEL_KEYS.includes(key)) ||
		TOP_LEVEL_KEYS.some((key) => !(key in marker)) ||
		marker.version !== 1 ||
		!MARKER_KINDS.includes(marker.kind) ||
		!MARKER_ID.test(marker.id) ||
		!timestamp(marker.occurredAt) ||
		typeof marker.semanticFingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(marker.semanticFingerprint)
	)
		return false;
	return validIdentity(marker, marker.kind === "retention-gap") && detailsShape(marker);
}
export function validateMessageLogMarker(marker: MessageLogMarker): void {
	if (!validMarker(marker)) throw new Error("invalid-message-log-marker");
}

export function canonicalMessageLogMarkerBytes(marker: MessageLogMarker): Uint8Array {
	validateMessageLogMarker(marker);
	return new TextEncoder().encode(`${canonicalMessageLogJson(marker)}\n`);
}
