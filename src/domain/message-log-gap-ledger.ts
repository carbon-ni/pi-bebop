const GAP_CAUSES = [
	"store-unavailable",
	"lock-conflict",
	"write-failed",
	"id-conflict",
	"invalid-capture",
	"capture-capacity",
	"details-truncated",
] as const;
export type CaptureGapCause = (typeof GAP_CAUSES)[number];
export type CaptureGapRange = Readonly<{
	readonly endpointId: string | null;
	readonly epochId: string | null;
	readonly cause: CaptureGapCause;
	readonly firstSequence: number;
	readonly lastSequence: number;
	readonly firstOccurredAt: string;
	readonly lastOccurredAt: string;
	readonly attemptCount: number;
}>;

const RANGE_KEYS = [
	"endpointId",
	"epochId",
	"cause",
	"firstSequence",
	"lastSequence",
	"firstOccurredAt",
	"lastOccurredAt",
	"attemptCount",
] as const;
const ENDPOINT_ID = /^endpoint-[0-9a-f]{64}$/;
const EPOCH_ID = /^epoch-[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_RANGES = 256;
const NEWEST_RANGES = 255;

type UnknownRange = Record<string, unknown>;

function validTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
	const date = new Date(value);
	return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
function validIdentity(value: unknown, pattern: RegExp): boolean {
	return typeof value === "string" && pattern.test(value);
}
function validCause(value: unknown): value is CaptureGapCause {
	return typeof value === "string" && (GAP_CAUSES as readonly string[]).includes(value);
}
function validRangeShape(value: UnknownRange): boolean {
	return RANGE_KEYS.length === Object.keys(value).length && RANGE_KEYS.every((key) => key in value);
}
function validSequenceBounds(value: UnknownRange): boolean {
	return (
		Number.isSafeInteger(value.firstSequence) &&
		Number.isSafeInteger(value.lastSequence) &&
		(value.firstSequence as number) >= 1 &&
		(value.lastSequence as number) >= (value.firstSequence as number)
	);
}
function validCount(value: UnknownRange): boolean {
	if (!Number.isSafeInteger(value.attemptCount) || (value.attemptCount as number) < 1) return false;
	if (value.cause === "details-truncated") return true;
	return value.attemptCount === (value.lastSequence as number) - (value.firstSequence as number) + 1;
}
function validRange(value: CaptureGapRange): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as UnknownRange;
	if (!validRangeShape(candidate) || !validCause(candidate.cause) || !validSequenceBounds(candidate)) return false;
	if (!validTimestamp(candidate.firstOccurredAt) || !validTimestamp(candidate.lastOccurredAt)) return false;
	if (candidate.firstOccurredAt > candidate.lastOccurredAt || !validCount(candidate)) return false;
	if (candidate.cause === "details-truncated") return candidate.endpointId === null && candidate.epochId === null;
	return validIdentity(candidate.endpointId, ENDPOINT_ID) && validIdentity(candidate.epochId, EPOCH_ID);
}
export function validateCaptureGapRange(range: CaptureGapRange): void {
	if (!validRange(range)) throw new Error("invalid-capture-gap-range");
}
function compareRanges(left: CaptureGapRange, right: CaptureGapRange): number {
	return (
		left.firstSequence - right.firstSequence ||
		left.lastSequence - right.lastSequence ||
		left.firstOccurredAt.localeCompare(right.firstOccurredAt) ||
		left.lastOccurredAt.localeCompare(right.lastOccurredAt) ||
		(left.endpointId ?? "").localeCompare(right.endpointId ?? "") ||
		(left.epochId ?? "").localeCompare(right.epochId ?? "") ||
		left.cause.localeCompare(right.cause)
	);
}
function sameKey(left: CaptureGapRange, right: CaptureGapRange): boolean {
	return left.endpointId === right.endpointId && left.epochId === right.epochId && left.cause === right.cause;
}
function adjacent(left: CaptureGapRange, right: CaptureGapRange): boolean {
	return left.lastSequence + 1 === right.firstSequence || right.lastSequence + 1 === left.firstSequence;
}
function mergePair(left: CaptureGapRange, right: CaptureGapRange): CaptureGapRange {
	const ordered = compareRanges(left, right) <= 0 ? [left, right] : [right, left];
	const first = ordered[0];
	const last = ordered[1];
	return {
		...first,
		firstOccurredAt: first.firstOccurredAt < last.firstOccurredAt ? first.firstOccurredAt : last.firstOccurredAt,
		lastSequence: Math.max(first.lastSequence, last.lastSequence),
		lastOccurredAt: first.lastOccurredAt > last.lastOccurredAt ? first.lastOccurredAt : last.lastOccurredAt,
		attemptCount: first.attemptCount + last.attemptCount,
	};
}
function mergeAdjacent(ranges: readonly CaptureGapRange[], incoming: CaptureGapRange): CaptureGapRange[] {
	const result = [...ranges, incoming];
	let changed = true;
	while (changed) {
		changed = false;
		for (let index = 0; index < result.length; index += 1) {
			const current = result[index];
			const partnerIndex = result.findIndex(
				(candidate, candidateIndex) =>
					candidateIndex !== index && sameKey(current, candidate) && adjacent(current, candidate),
			);
			if (partnerIndex === -1) continue;
			const merged = mergePair(current, result[partnerIndex]);
			const high = Math.max(index, partnerIndex);
			const low = Math.min(index, partnerIndex);
			result.splice(high, 1);
			result.splice(low, 1);
			result.push(merged);
			changed = true;
			break;
		}
	}
	return result;
}
function coalesceOldest(ranges: readonly CaptureGapRange[]): CaptureGapRange[] {
	if (ranges.length <= MAX_RANGES) return [...ranges].sort(compareRanges);
	const ordered = [...ranges].sort(compareRanges);
	const oldest = ordered.slice(0, ordered.length - NEWEST_RANGES);
	const newest = ordered.slice(-NEWEST_RANGES);
	const firstOccurredAt = oldest.reduce(
		(value, range) => (range.firstOccurredAt < value ? range.firstOccurredAt : value),
		oldest[0].firstOccurredAt,
	);
	const lastOccurredAt = oldest.reduce(
		(value, range) => (range.lastOccurredAt > value ? range.lastOccurredAt : value),
		oldest[0].lastOccurredAt,
	);
	const truncated: CaptureGapRange = {
		endpointId: null,
		epochId: null,
		cause: "details-truncated",
		firstSequence: Math.min(...oldest.map((range) => range.firstSequence)),
		lastSequence: Math.max(...oldest.map((range) => range.lastSequence)),
		firstOccurredAt,
		lastOccurredAt,
		attemptCount: oldest.reduce((sum, range) => sum + range.attemptCount, 0),
	};
	return [truncated, ...newest].sort(compareRanges);
}
export function mergeCaptureGapRange(
	ledger: readonly CaptureGapRange[],
	incoming: CaptureGapRange,
): readonly CaptureGapRange[] {
	ledger.forEach(validateCaptureGapRange);
	validateCaptureGapRange(incoming);
	return coalesceOldest(mergeAdjacent(ledger, incoming));
}
