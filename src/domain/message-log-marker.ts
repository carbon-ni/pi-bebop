import { canonicalMessageLogJson } from "./message-log-entry.ts";

const MARKER_KINDS = ["epoch-open", "coverage-checkpoint", "epoch-clean-close"] as const;
export type MessageLogMarkerKind = (typeof MARKER_KINDS)[number];
export type MessageLogMarker = Readonly<{
	version: 1;
	kind: MessageLogMarkerKind;
	id: string;
	occurredAt: string;
	endpointId: string;
	epochId: string;
	attemptSequence: number;
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

function timestamp(value: unknown): boolean {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const parsed = new Date(value);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
function detailsShape(marker: MessageLogMarker): boolean {
	const details = marker.details;
	if (
		!details ||
		typeof details !== "object" ||
		Object.keys(details).some(
			(key) => !["openedAt", "priorMarkerId", "intervalEnd", "lastAttemptSequence", "closedAt"].includes(key),
		)
	)
		return false;
	if (marker.kind === "epoch-open")
		return (
			Object.keys(details).length === 2 &&
			timestamp(details.openedAt) &&
			(details.priorMarkerId === null || MARKER_ID.test(String(details.priorMarkerId)))
		);
	if (marker.kind === "coverage-checkpoint")
		return (
			Object.keys(details).length === 2 &&
			timestamp(details.intervalEnd) &&
			Number.isSafeInteger(details.lastAttemptSequence) &&
			(details.lastAttemptSequence as number) >= 1
		);
	return (
		Object.keys(details).length === 2 &&
		timestamp(details.closedAt) &&
		Number.isSafeInteger(details.lastAttemptSequence) &&
		(details.lastAttemptSequence as number) >= 1
	);
}
export function validateMessageLogMarker(marker: MessageLogMarker): void {
	if (
		!marker ||
		typeof marker !== "object" ||
		Object.keys(marker).some((key) => !TOP_LEVEL_KEYS.includes(key)) ||
		TOP_LEVEL_KEYS.some((key) => !(key in marker)) ||
		marker.version !== 1 ||
		!MARKER_KINDS.includes(marker.kind) ||
		!MARKER_ID.test(marker.id) ||
		!timestamp(marker.occurredAt) ||
		!ENDPOINT_ID.test(marker.endpointId) ||
		!EPOCH_ID.test(marker.epochId) ||
		!Number.isSafeInteger(marker.attemptSequence) ||
		marker.attemptSequence < 1 ||
		!/^[0-9a-f]{64}$/.test(marker.semanticFingerprint) ||
		!detailsShape(marker)
	)
		throw new Error("invalid-message-log-marker");
}

export function canonicalMessageLogMarkerBytes(marker: MessageLogMarker): Uint8Array {
	validateMessageLogMarker(marker);
	return new TextEncoder().encode(`${canonicalMessageLogJson(marker)}\n`);
}
