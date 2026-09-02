import {
	canonicalMessageLogMarkerBytes,
	validateMessageLogMarker,
	type MessageLogMarker,
} from "../domain/index.ts";
import { MessageLogStoreError, type MessageLogStoreErrorCode } from "./message-log-store.ts";
import { appendMarkerLocked, readAllMarkers } from "./message-log-marker-store.ts";

type RecoveryFs = {
	readonly readFile: (filePath: string) => Promise<Buffer>;
	readonly readdir: (directory: string) => Promise<string[]>;
	readonly writeFile: (filePath: string, data: Uint8Array, options: { flag: string }) => Promise<void>;
};
type RecoveryAccess = { readonly logDir: string };
type WithLock = (work: (retentionNow: number, persistedRetentionNow: number) => Promise<void>) => Promise<void>;
type RecoveryResult = {
	readonly durableMarkerIds: readonly string[];
	readonly durableOpenId: string | null;
	readonly priorState: "clean-close" | "unclean" | "unknown-before-first-marker";
	readonly errorCode: MessageLogStoreErrorCode | null;
};

function invalid(message: string): never {
	throw new MessageLogStoreError("invalid-entry", message);
}
function asErrorCode(error: unknown): MessageLogStoreErrorCode {
	return error instanceof MessageLogStoreError ? error.code : "write-failed";
}
function detailsValue(marker: MessageLogMarker, key: string): unknown {
	return marker.details[key];
}
function validateOpenMarker(open: MessageLogMarker): void {
	validateMessageLogMarker(open);
	if (open.kind !== "epoch-open" || open.attemptSequence !== 1 || detailsValue(open, "openedAt") !== open.occurredAt) invalid("epoch-open marker is invalid");
}
function validateUnverifiedMarker(open: MessageLogMarker, unverified: MessageLogMarker): void {
	validateMessageLogMarker(unverified);
	if (unverified.kind !== "unverified-capture" || unverified.endpointId !== open.endpointId || unverified.epochId !== open.epochId || unverified.attemptSequence !== 1 || unverified.occurredAt !== open.occurredAt) invalid("unverified-capture marker is invalid");
	const interval = detailsValue(unverified, "interval");
	if (!interval || typeof interval !== "object" || Array.isArray(interval) || (interval as Record<string, unknown>).end !== open.occurredAt || (interval as Record<string, unknown>).start >= open.occurredAt) invalid("unverified-capture interval is invalid");
}
function preflight(open: MessageLogMarker, unverified: MessageLogMarker | null): void {
	if (unverified && open.id === unverified.id) invalid("recovery marker IDs must be distinct");
	try {
		validateOpenMarker(open);
		if (unverified) validateUnverifiedMarker(open, unverified);
	} catch (error) {
		if (error instanceof MessageLogStoreError) throw error;
		invalid("epoch-open recovery marker is invalid");
	}
}
function latest(markers: readonly MessageLogMarker[], endpointId: string, before: string): MessageLogMarker | null {
	const scoped = markers.filter((marker) => marker.endpointId === endpointId && marker.occurredAt < before);
	return scoped.sort((left, right) => `${left.occurredAt}\u0000${left.id}`.localeCompare(`${right.occurredAt}\u0000${right.id}`)).at(-1) ?? null;
}
type PriorState = "clean-close" | "unclean" | "unknown-before-first-marker";
function replayState(open: MessageLogMarker, unverified: MessageLogMarker | null, existing: MessageLogMarker, markers: readonly MessageLogMarker[]): PriorState {
	if (Buffer.compare(Buffer.from(canonicalMessageLogMarkerBytes(existing)), Buffer.from(canonicalMessageLogMarkerBytes(open))) !== 0) throw new MessageLogStoreError("id-conflict", "message log marker identity conflict");
	if (unverified && !markers.some((marker) => marker.id === unverified.id)) invalid("recovery marker is incomplete");
	return "clean-close";
}
function priorState(prior: MessageLogMarker | null): PriorState {
	if (!prior) return "unknown-before-first-marker";
	if (prior.kind === "epoch-clean-close") return "clean-close";
	if (prior.kind === "epoch-open" || prior.kind === "coverage-checkpoint") return "unclean";
	return invalid("message log history cannot be recovered");
}
function checkPriorIds(open: MessageLogMarker, unverified: MessageLogMarker | null, prior: MessageLogMarker | null, state: PriorState): void {
	if (detailsValue(open, "priorMarkerId") !== (prior?.id ?? null)) invalid("epoch-open prior marker is invalid");
	if (state === "unclean") {
		if (!unverified || detailsValue(unverified, "priorMarkerId") !== prior?.id || detailsValue(unverified, "priorEpochId") !== prior?.epochId) invalid("unverified-capture prior marker is invalid");
	} else if (unverified) invalid("unverified-capture marker is unexpected");
}
function checkHistory(open: MessageLogMarker, unverified: MessageLogMarker | null, markers: readonly MessageLogMarker[]): PriorState {
	const existingOpen = markers.find((marker) => marker.id === open.id);
	if (existingOpen) return replayState(open, unverified, existingOpen, markers);
	const prior = latest(markers, open.endpointId as string, open.occurredAt);
	const state = priorState(prior);
	checkPriorIds(open, unverified, prior, state);
	return state;
}
function result(ids: readonly string[], openId: string | null, priorState: RecoveryResult["priorState"], errorCode: MessageLogStoreErrorCode | null): RecoveryResult {
	return { durableMarkerIds: [...ids], durableOpenId: openId, priorState, errorCode };
}

export async function appendEpochOpenRecovery(
	open: MessageLogMarker,
	unverified: MessageLogMarker | null,
	access: RecoveryAccess,
	io: RecoveryFs,
	prepare: () => Promise<void>,
	withLock: WithLock,
	publish: (temp: string, target: string, bytes: Uint8Array) => Promise<void>,
	advanceRetention: (retentionNow: number, persistedRetentionNow: number) => Promise<void>,
): Promise<RecoveryResult> {
	preflight(open, unverified);
	const markers = [open, ...(unverified ? [unverified] : [])];
	const bytes = markers.map(canonicalMessageLogMarkerBytes);
	if (bytes.some((value) => value.byteLength > 16 * 1024)) throw new MessageLogStoreError("capacity-exceeded", "message log marker exceeds capacity");
	const durableMarkerIds: string[] = [];
	let durableOpenId: string | null = null;
	let priorState: RecoveryResult["priorState"] = "unknown-before-first-marker";
	try {
		await prepare();
		await withLock(async (retentionNow, persistedRetentionNow) => {
			const history = await readAllMarkers(access.logDir, io);
			priorState = checkHistory(open, unverified, history);
			const ordered = unverified && priorState === "unclean" ? [unverified, open] : [open];
			for (const marker of ordered) {
				const markerBytes = bytes[markers.findIndex((candidate) => candidate.id === marker.id)];
				await appendMarkerLocked(marker, markerBytes, access.logDir, io, publish);
				durableMarkerIds.push(marker.id);
				if (marker.id === open.id) durableOpenId = marker.id;
			}
			await advanceRetention(retentionNow, persistedRetentionNow);
		});
		return result(durableMarkerIds, durableOpenId, priorState, null);
	} catch (error) {
		return result(durableMarkerIds, durableOpenId, priorState, asErrorCode(error));
	}
}
