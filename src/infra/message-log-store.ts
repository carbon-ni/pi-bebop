import { promises as fs } from "node:fs";
import * as path from "node:path";
import { canonicalMessageLogEntryBytes, validateMessageLogEntry, type MessageLogEntry } from "../domain/index.ts";

export type MessageLogStoreErrorCode =
	| "untrusted-project"
	| "id-conflict"
	| "lock-conflict"
	| "invalid-entry"
	| "write-failed";
export class MessageLogStoreError extends Error {
	constructor(
		readonly code: MessageLogStoreErrorCode,
		message: string,
	) {
		super(message);
		this.name = "MessageLogStoreError";
	}
}

export interface MessageLogStoreOptions {
	readonly root: string;
	readonly isTrusted: () => boolean;
	readonly fs?: Pick<typeof fs, "mkdir" | "readFile" | "writeFile" | "rename" | "open" | "unlink">;
}

export function createMessageLogStore(options: MessageLogStoreOptions) {
	const io = options.fs ?? fs;
	const dir = path.join(options.root, "message-log");
	const fileFor = (id: string) => path.join(dir, `${id}.json`);
	return {
		async append(entry: MessageLogEntry): Promise<void> {
			if (!options.isTrusted())
				throw new MessageLogStoreError("untrusted-project", "message log requires a trusted project");
			try {
				validateMessageLogEntry(entry);
			} catch {
				throw new MessageLogStoreError("invalid-entry", "message log entry is invalid");
			}
			const bytes = canonicalMessageLogEntryBytes(entry);
			await io.mkdir(dir, { recursive: true });
			const lock = path.join(dir, ".lock");
			let handle: Awaited<ReturnType<typeof io.open>>;
			try {
				handle = await io.open(lock, "wx");
			} catch {
				throw new MessageLogStoreError("lock-conflict", "message log is busy");
			}
			try {
				if (!/^entry-[0-9a-f]{64}$/.test(String(entry.id)))
					throw new MessageLogStoreError("invalid-entry", "message log entry id is invalid");
				const target = fileFor(String(entry.id));
				try {
					const existing = await io.readFile(target);
					if (Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0)
						throw new MessageLogStoreError("id-conflict", "message log entry identity conflict");
					return;
				} catch (error) {
					if (error instanceof MessageLogStoreError) throw error;
				}
				const temp = `${target}.tmp-${process.pid}`;
				await io.writeFile(temp, bytes, { flag: "wx" });
				await io.rename(temp, target);
			} finally {
				await handle.close();
				await io.unlink(lock).catch(() => undefined);
			}
		},
		async read(id: string): Promise<Uint8Array | null> {
			if (!options.isTrusted())
				throw new MessageLogStoreError("untrusted-project", "message log requires a trusted project");
			if (!/^entry-[0-9a-f]{64}$/.test(id))
				throw new MessageLogStoreError("invalid-entry", "message log entry id is invalid");
			try {
				return new Uint8Array(await io.readFile(fileFor(id)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw new MessageLogStoreError("write-failed", "message log read failed");
			}
		},
	};
}
