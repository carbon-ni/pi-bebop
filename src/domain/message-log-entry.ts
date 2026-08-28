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

const CANONICAL_KEYS = [
	...REQUIRED,
	"actorKind",
	"sourceMember",
	"targetMember",
	"claimedOrigin",
	"deliveryIntent",
	"correlations",
	"summary",
];

export function validateMessageLogEntry(entry: MessageLogEntry): void {
	for (const key of REQUIRED) if (!(key in entry)) throw new Error(`missing-message-log-field:${key}`);
	if (entry.version !== 1 || entry.kind !== "message-event") throw new Error("invalid-message-log-schema");
	if (
		!entry.operation ||
		typeof entry.operation !== "object" ||
		typeof (entry.operation as any).id !== "string" ||
		!Number.isSafeInteger((entry.operation as any).lifecycleSequence)
	)
		throw new Error("invalid-message-log-operation");
	if (
		!entry.payload ||
		typeof entry.payload !== "object" ||
		!["represented", "unavailable"].includes((entry.payload as any).state) ||
		!Array.isArray((entry.payload as any).instructions) ||
		!Number.isSafeInteger((entry.payload as any).instructionCount)
	)
		throw new Error("invalid-message-log-payload");
	if (
		!entry.capture ||
		typeof entry.capture !== "object" ||
		typeof (entry.capture as any).endpointId !== "string" ||
		typeof (entry.capture as any).epochId !== "string" ||
		!Number.isSafeInteger((entry.capture as any).attemptSequence) ||
		typeof (entry.capture as any).capturedAt !== "string"
	)
		throw new Error("invalid-message-log-capture");
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
	const ordered: Record<string, unknown> = {};
	for (const key of CANONICAL_KEYS) if (key in entry) ordered[key] = entry[key];
	return new TextEncoder().encode(`${JSON.stringify(ordered)}\n`);
}
