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

function requiredFields(entry: MessageLogEntry): void {
	for (const key of REQUIRED) if (!(key in entry)) throw new Error(`missing-message-log-field:${key}`);
}
function closedFields(entry: MessageLogEntry): void {
	const optional = new Set([
		"actorKind",
		"sourceMember",
		"targetMember",
		"claimedOrigin",
		"deliveryIntent",
		"correlations",
		"summary",
	]);
	if (Object.keys(entry).some((key) => !REQUIRED.includes(key as never) && !optional.has(key)))
		throw new Error("unknown-message-log-field");
}
function nestedFields(entry: MessageLogEntry): void {
	const operation = entry.operation as any;
	if (
		!operation ||
		typeof operation !== "object" ||
		typeof operation.id !== "string" ||
		!Number.isSafeInteger(operation.lifecycleSequence)
	)
		throw new Error("invalid-message-log-operation");
	const payload = entry.payload as any;
	if (
		!payload ||
		typeof payload !== "object" ||
		!["represented", "unavailable"].includes(payload.state) ||
		!Array.isArray(payload.instructions) ||
		!Number.isSafeInteger(payload.instructionCount)
	)
		throw new Error("invalid-message-log-payload");
	const capture = entry.capture as any;
	if (
		!capture ||
		typeof capture !== "object" ||
		typeof capture.endpointId !== "string" ||
		typeof capture.epochId !== "string" ||
		!Number.isSafeInteger(capture.attemptSequence) ||
		typeof capture.capturedAt !== "string"
	)
		throw new Error("invalid-message-log-capture");
}
export function validateMessageLogEntry(entry: MessageLogEntry): void {
	requiredFields(entry);
	if (entry.version !== 1 || entry.kind !== "message-event") throw new Error("invalid-message-log-schema");
	closedFields(entry);
	nestedFields(entry);
}

export function canonicalMessageLogEntryBytes(entry: MessageLogEntry): Uint8Array {
	validateMessageLogEntry(entry);
	const ordered: Record<string, unknown> = {};
	for (const key of CANONICAL_KEYS) if (key in entry) ordered[key] = entry[key];
	return new TextEncoder().encode(`${JSON.stringify(ordered)}\n`);
}
