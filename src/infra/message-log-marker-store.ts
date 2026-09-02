import * as path from "node:path";
import { canonicalMessageLogMarkerBytes, validateMessageLogMarker, type MessageLogMarker } from "../domain/index.ts";
import { MessageLogStoreError } from "./message-log-store.ts";

type MarkerFs = {
	readonly readFile: (filePath: string) => Promise<Buffer>;
	readonly readdir: (directory: string) => Promise<string[]>;
	readonly writeFile: (filePath: string, data: Uint8Array, options: { flag: string }) => Promise<void>;
};
type MarkerAccess = { readonly logDir: string; readonly trustedLogDir: string };

const MAX_MARKER_BYTES = 16 * 1024;
const MAX_SCAN_RECORDS = 50_000;

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isMarkerFile(fileName: string): boolean {
	return /^marker-[0-9a-f]{64}\.json$/.test(fileName);
}
function validateStoredMarker(bytes: Uint8Array): MessageLogMarker {
	if (bytes.byteLength > MAX_MARKER_BYTES)
		throw new MessageLogStoreError("invalid-entry", "message log marker is invalid");
	try {
		const marker = JSON.parse(Buffer.from(bytes).toString("utf8")) as MessageLogMarker;
		validateMessageLogMarker(marker);
		if (Buffer.compare(Buffer.from(bytes), Buffer.from(canonicalMessageLogMarkerBytes(marker))) !== 0)
			throw new Error("noncanonical");
		return marker;
	} catch {
		throw new MessageLogStoreError("invalid-entry", "message log marker is invalid");
	}
}
function latestMarker(current: MessageLogMarker | null, candidate: MessageLogMarker): MessageLogMarker {
	if (!current) return candidate;
	const currentKey = `${current.occurredAt}\u0000${current.epochId}\u0000${current.attemptSequence}\u0000${current.id}`;
	const candidateKey = `${candidate.occurredAt}\u0000${candidate.epochId}\u0000${candidate.attemptSequence}\u0000${candidate.id}`;
	return candidateKey > currentKey ? candidate : current;
}

export async function appendMarkerLocked(
	marker: MessageLogMarker,
	bytes: Uint8Array,
	logDir: string,
	io: MarkerFs,
	publish: (temp: string, target: string, bytes: Uint8Array) => Promise<void>,
): Promise<void> {
	const target = path.join(logDir, `${marker.id}.json`);
	try {
		const existing = await io.readFile(target);
		if (Buffer.compare(existing, Buffer.from(bytes)) !== 0)
			throw new MessageLogStoreError("id-conflict", "message log marker identity conflict");
		return;
	} catch (error) {
		if (error instanceof MessageLogStoreError) throw error;
		if (!isCode(error, "ENOENT")) throw error;
	}
	const temp = `${target}.tmp-${process.pid}`;
	await io.writeFile(temp, bytes, { flag: "wx" });
	await publish(temp, target, bytes);
}

export async function appendMarker(
	marker: MessageLogMarker,
	bytes: Uint8Array,
	logDir: string,
	io: MarkerFs,
	withLock: (work: (retentionNow: number, persistedRetentionNow: number) => Promise<void>) => Promise<void>,
	publish: (temp: string, target: string, bytes: Uint8Array) => Promise<void>,
	advanceRetention: (retentionNow: number, persistedRetentionNow: number) => Promise<void>,
): Promise<void> {
	await withLock(async (retentionNow, persistedRetentionNow) => {
		await appendMarkerLocked(marker, bytes, logDir, io, publish);
		await advanceRetention(retentionNow, persistedRetentionNow);
	});
}

export async function appendMarkerOperation(
	marker: MessageLogMarker,
	access: MarkerAccess,
	io: MarkerFs,
	prepare: () => Promise<void>,
	withLock: (work: (retentionNow: number, persistedRetentionNow: number) => Promise<void>) => Promise<void>,
	publish: (temp: string, target: string, bytes: Uint8Array) => Promise<void>,
	advanceRetention: (retentionNow: number, persistedRetentionNow: number) => Promise<void>,
): Promise<void> {
	try {
		validateMessageLogMarker(marker);
	} catch {
		throw new MessageLogStoreError("invalid-entry", "message log marker is invalid");
	}
	const bytes = canonicalMessageLogMarkerBytes(marker);
	if (bytes.byteLength > MAX_MARKER_BYTES)
		throw new MessageLogStoreError("capacity-exceeded", "message log marker exceeds capacity");
	await prepare();
	await withLock(async (retentionNow, persistedRetentionNow) => {
		await appendMarkerLocked(marker, bytes, access.logDir, io, publish);
		await advanceRetention(retentionNow, persistedRetentionNow);
	});
}

export async function readLastCheckpointClose(
	logDir: string,
	io: MarkerFs,
	endpointId: string,
): Promise<{ readonly checkpoint: MessageLogMarker | null; readonly close: MessageLogMarker | null }> {
	let files: string[];
	try {
		files = await io.readdir(logDir);
	} catch (error) {
		if (isCode(error, "ENOENT")) return { checkpoint: null, close: null };
		throw new MessageLogStoreError("write-failed", "message log scan failed");
	}
	const markerFiles = files.filter(isMarkerFile);
	if (markerFiles.length > MAX_SCAN_RECORDS)
		throw new MessageLogStoreError("capacity-exceeded", "message log scan exceeds capacity");
	let checkpoint: MessageLogMarker | null = null;
	let close: MessageLogMarker | null = null;
	for (const file of markerFiles) {
		let bytes: Buffer;
		try {
			bytes = await io.readFile(path.join(logDir, file));
		} catch {
			throw new MessageLogStoreError("write-failed", "message log marker could not be read");
		}
		const marker = validateStoredMarker(bytes);
		if (marker.id !== file.slice(0, -5))
			throw new MessageLogStoreError("invalid-entry", "message log marker is invalid");
		if (marker.endpointId !== endpointId) continue;
		if (marker.kind === "coverage-checkpoint") checkpoint = latestMarker(checkpoint, marker);
		if (marker.kind === "epoch-clean-close") close = latestMarker(close, marker);
	}
	return { checkpoint, close };
}
