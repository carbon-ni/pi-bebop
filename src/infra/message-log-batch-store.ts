import {
	canonicalMessageLogEntryBytes,
	canonicalMessageLogMarkerBytes,
	validateMessageLogEntry,
	validateMessageLogMarker,
	validateCaptureGapRange,
	type CaptureGapRange,
	type MessageLogEntry,
	type MessageLogMarker,
} from "../domain/index.ts";
import { MessageLogStoreError, type MessageLogStoreErrorCode } from "./message-log-store.ts";
import { appendMarkerLocked } from "./message-log-marker-store.ts";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;

type BatchFs = {
	readonly readFile: (filePath: string) => Promise<Buffer>;
	readonly readdir: (directory: string) => Promise<string[]>;
	readonly writeFile: (filePath: string, data: Uint8Array, options: { flag: string }) => Promise<void>;
};
type BatchAccess = { readonly logDir: string };
type IncomingRecord = MessageLogEntry | MessageLogMarker;
export type PendingGapFlushResult = {
	readonly durableMarkerIds: readonly string[];
	readonly durableIncomingId: string | null;
	readonly pendingRanges: readonly CaptureGapRange[];
	readonly errorCode: MessageLogStoreErrorCode | null;
};
type WithLock = (work: (retentionNow: number, persistedRetentionNow: number) => Promise<void>) => Promise<void>;
type AppendEntry = (
	entry: MessageLogEntry,
	bytes: Uint8Array,
	retentionNow: number,
	persistedRetentionNow: number,
) => Promise<void>;

function invalidBatch(): never {
	throw new MessageLogStoreError("invalid-entry", "message log batch is invalid");
}
function asBatchError(error: unknown): MessageLogStoreErrorCode {
	if (error instanceof MessageLogStoreError) return error.code;
	return "write-failed";
}
function validRangeOrder(ranges: readonly CaptureGapRange[]): boolean {
	return ranges.every((range, index) => index === 0 || ranges[index - 1].firstSequence <= range.firstSequence);
}
function isMessageEvent(record: IncomingRecord): record is MessageLogEntry {
	return record.kind === "message-event";
}
function markerMatchesRange(marker: MessageLogMarker, range: CaptureGapRange): boolean {
	if (range.cause !== "details-truncated" && (marker.endpointId !== range.endpointId || marker.epochId !== range.epochId)) return false;
	const details = marker.details;
	return details.cause === range.cause && details.firstSequence === range.firstSequence && details.lastSequence === range.lastSequence && details.firstOccurredAt === range.firstOccurredAt && details.lastOccurredAt === range.lastOccurredAt && details.attemptCount === range.attemptCount;
}
function preflight(
	ranges: readonly CaptureGapRange[],
	markers: readonly MessageLogMarker[],
	incoming: IncomingRecord,
): { readonly markerBytes: readonly Uint8Array[]; readonly incomingBytes: Uint8Array } {
	if (ranges.length !== markers.length || !validRangeOrder(ranges)) invalidBatch();
	try {
		ranges.forEach(validateCaptureGapRange);
		markers.forEach((marker, index) => {
			validateMessageLogMarker(marker);
			if (marker.kind !== "capture-gap" || !markerMatchesRange(marker, ranges[index])) invalidBatch();
		});
	} catch (error) {
		if (error instanceof MessageLogStoreError) throw error;
		invalidBatch();
	}
	const markerIds = new Set(markers.map((marker) => marker.id));
	if (markerIds.size !== markers.length || markerIds.has(String(incoming.id))) invalidBatch();
	const markerBytes = markers.map(canonicalMessageLogMarkerBytes);
	if (markerBytes.some((bytes) => bytes.byteLength > MAX_MARKER_BYTES))
		throw new MessageLogStoreError("capacity-exceeded", "message log marker exceeds capacity");
	let incomingBytes: Uint8Array;
	try {
		if (isMessageEvent(incoming)) {
			const entry = incoming;
			validateMessageLogEntry(entry);
			incomingBytes = canonicalMessageLogEntryBytes(entry);
		} else {
			const marker = incoming as MessageLogMarker;
			validateMessageLogMarker(marker);
			if (marker.kind !== "coverage-checkpoint" && marker.kind !== "epoch-clean-close") invalidBatch();
			incomingBytes = canonicalMessageLogMarkerBytes(marker);
		}
	} catch (error) {
		if (error instanceof MessageLogStoreError) throw error;
		invalidBatch();
	}
	if (incomingBytes.byteLength > (isMessageEvent(incoming) ? MAX_EVENT_BYTES : MAX_MARKER_BYTES))
		throw new MessageLogStoreError("capacity-exceeded", "message log record exceeds capacity");
	return { markerBytes, incomingBytes };
}
function result(
	durableMarkerIds: readonly string[],
	pendingRanges: readonly CaptureGapRange[],
	durableIncomingId: string | null,
	errorCode: MessageLogStoreErrorCode | null,
): PendingGapFlushResult {
	return { durableMarkerIds: [...durableMarkerIds], durableIncomingId, pendingRanges: [...pendingRanges], errorCode };
}

export async function appendPendingGapBatch(
	ranges: readonly CaptureGapRange[],
	markers: readonly MessageLogMarker[],
	incoming: IncomingRecord,
	access: BatchAccess,
	io: BatchFs,
	prepare: () => Promise<void>,
	withLock: WithLock,
	publish: (temp: string, target: string, bytes: Uint8Array) => Promise<void>,
	appendEntry: AppendEntry,
	advanceRetention: (retentionNow: number, persistedRetentionNow: number) => Promise<void>,
): Promise<PendingGapFlushResult> {
	const { markerBytes, incomingBytes } = preflight(ranges, markers, incoming);
	const durableMarkerIds: string[] = [];
	const incomingId = String((incoming as { readonly id: unknown }).id);
	let durableIncomingId: string | null = null;
	let pendingIndex = 0;
	try {
		await prepare();
		await withLock(async (retentionNow, persistedRetentionNow) => {
			for (let index = 0; index < markers.length; index += 1) {
				const marker = markers[index];
				await appendMarkerLocked(marker, markerBytes[index], access.logDir, io, publish);
				durableMarkerIds.push(marker.id);
				pendingIndex = index + 1;
			}
			if (isMessageEvent(incoming)) await appendEntry(incoming, incomingBytes, retentionNow, persistedRetentionNow);
			else {
				await appendMarkerLocked(incoming, incomingBytes, access.logDir, io, publish);
				durableIncomingId = incomingId;
			}
			if (!isMessageEvent(incoming)) await advanceRetention(retentionNow, persistedRetentionNow);
		});
		return result(durableMarkerIds, [], durableIncomingId ?? incomingId, null);
	} catch (error) {
		return result(durableMarkerIds, ranges.slice(pendingIndex), durableIncomingId, asBatchError(error));
	}
}
