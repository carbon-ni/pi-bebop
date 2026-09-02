import * as path from "node:path";
import { canonicalMessageLogEntryBytes, validateMessageLogEntry, type MessageLogEntry } from "../domain/index.ts";
import { MessageLogStoreError } from "./message-log-store.ts";

type EntryReaderFs = {
	readonly readFile: (filePath: string) => Promise<Buffer>;
};

export function validateStoredEntry(id: string, bytes: Uint8Array): void {
	if (bytes.byteLength > 64 * 1024) throw new MessageLogStoreError("invalid-entry", "message log entry is invalid");
	let parsed: MessageLogEntry;
	try {
		parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as MessageLogEntry;
		validateMessageLogEntry(parsed);
	} catch {
		throw new MessageLogStoreError("invalid-entry", "message log entry is invalid");
	}
	if (parsed.id !== id) throw new MessageLogStoreError("invalid-entry", "message log entry is invalid");
	try {
		if (Buffer.compare(Buffer.from(bytes), Buffer.from(canonicalMessageLogEntryBytes(parsed))) !== 0)
			throw new Error("noncanonical");
	} catch {
		throw new MessageLogStoreError("invalid-entry", "message log entry is invalid");
	}
}

export async function readMessageLogEntry(
	id: string,
	logDir: string,
	io: EntryReaderFs,
	validateStored: (id: string, bytes: Uint8Array) => void,
): Promise<Uint8Array | null> {
	const target = path.join(logDir, `${id}.json`);
	try {
		const bytes = new Uint8Array(await io.readFile(target));
		validateStored(id, bytes);
		return bytes;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		if (error instanceof MessageLogStoreError) throw error;
		throw new MessageLogStoreError("write-failed", "message log read failed");
	}
}
