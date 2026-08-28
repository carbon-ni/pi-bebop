export type MessageLogErrorCode = "invalid-capture" | "record-capacity" | "unsupported-control";
export type MessageLogEntry = Readonly<Record<string, unknown>>;

const REQUIRED = [
	"version",
	"kind",
	"id",
	"occurredAt",
	"surface",
	"stage",
	"outcome",
	"operation",
	"payload",
	"errorCode",
	"capture",
	"semanticFingerprint",
] as const;

export function validateMessageLogEntry(entry: MessageLogEntry): void {
	for (const key of REQUIRED) if (!(key in entry)) throw new Error(`missing-message-log-field:${key}`);
	if (entry.version !== 1 || entry.kind !== "message-event") throw new Error("invalid-message-log-schema");
	if (
		Object.keys(entry).some(
			(key) =>
				!REQUIRED.includes(key as never) &&
				key !== "actorKind" &&
				key !== "sourceMember" &&
				key !== "targetMember" &&
				key !== "claimedOrigin" &&
				key !== "deliveryIntent" &&
				key !== "correlations" &&
				key !== "summary",
		)
	)
		throw new Error("unknown-message-log-field");
}

export function canonicalMessageLogEntryBytes(entry: MessageLogEntry): Uint8Array {
	validateMessageLogEntry(entry);
	return new TextEncoder().encode(JSON.stringify(entry));
}
