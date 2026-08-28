export interface MessageLogEntry {
	readonly id: string;
	readonly occurredAt: string;
	readonly surface: string;
	readonly content: string;
}

export function canonicalMessageLogBytes(entry: MessageLogEntry): Uint8Array {
	if (Object.keys(entry).some((key) => !["id", "occurredAt", "surface", "content"].includes(key)))
		throw new Error("invalid-message-log-entry");
	if (!entry.id || !entry.surface || !entry.occurredAt || typeof entry.content !== "string")
		throw new Error("invalid-message-log-entry");
	return new TextEncoder().encode(JSON.stringify(entry));
}
