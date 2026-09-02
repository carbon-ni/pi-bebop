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

const SURFACES = new Set([
	"follow-up",
	"redirect",
	"member-request",
	"member-response",
	"member-inbox",
	"crew-broadcast",
	"interrupt",
	"crew-intake",
]);
const STAGES = new Set([
	"delivery",
	"persistence",
	"handoff",
	"request-terminal",
	"broadcast-summary",
	"recovery",
	"abort",
]);
const OUTCOMES = new Set([
	"direct",
	"queued",
	"redirected",
	"offline",
	"persisted",
	"already-persisted",
	"offered",
	"handoff-recorded",
	"response-recorded",
	"timeout-max-wait",
	"timeout-response-after-idle",
	"cancelled",
	"pending",
	"already-pending",
	"abort-requested",
	"no-active-context",
	"complete",
	"partial",
	"no-recipients",
	"failed",
]);

const SURFACE_STAGE_OUTCOME: Record<string, Record<string, ReadonlySet<string>>> = {
	"follow-up": {
		delivery: new Set(["direct", "queued", "offline", "failed"]),
	},
	redirect: {
		delivery: new Set(["redirected", "offline", "failed"]),
	},
	"member-request": {
		delivery: new Set(["direct", "queued", "offline", "failed"]),
		"request-terminal": new Set([
			"response-recorded",
			"offline",
			"timeout-max-wait",
			"timeout-response-after-idle",
			"cancelled",
			"failed",
		]),
	},
	"member-response": {
		delivery: new Set(["direct", "queued", "offline", "failed"]),
	},
	"member-inbox": {
		persistence: new Set(["persisted", "already-persisted", "failed"]),
		handoff: new Set(["offered", "handoff-recorded", "cancelled", "failed"]),
	},
	"crew-broadcast": {
		persistence: new Set(["persisted", "already-persisted", "failed"]),
		handoff: new Set(["offered", "handoff-recorded", "cancelled", "failed"]),
		"broadcast-summary": new Set(["complete", "partial", "no-recipients", "failed"]),
	},
	interrupt: {
		recovery: new Set(["pending", "already-pending", "direct", "handoff-recorded", "failed"]),
		abort: new Set(["abort-requested", "no-active-context", "failed"]),
	},
	"crew-intake": {
		persistence: new Set(["persisted", "already-persisted", "failed"]),
		handoff: new Set(["offered", "handoff-recorded", "cancelled", "failed"]),
	},
};

const PAYLOAD_REQUIRED_MATRIX: Record<string, ReadonlySet<string>> = {
	"follow-up/delivery": new Set(["direct", "queued", "offline", "failed"]),
	"redirect/delivery": new Set(["redirected", "offline", "failed"]),
	"member-request/delivery": new Set(["direct", "queued", "offline", "failed"]),
	"member-response/delivery": new Set(["direct", "queued", "offline", "failed"]),
	"member-inbox/persistence": new Set(["persisted", "already-persisted", "failed"]),
	"crew-intake/persistence": new Set(["persisted", "already-persisted", "failed"]),
	"interrupt/recovery": new Set(["pending", "already-pending", "direct", "handoff-recorded", "failed"]),
	"crew-broadcast/broadcast-summary": new Set(["complete", "partial", "no-recipients", "failed"]),
};
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
function payloadContract(surface: string, stage: string, outcome: string): boolean {
	return PAYLOAD_REQUIRED_MATRIX[`${surface}/${stage}`]?.has(outcome) ?? false;
}

function scalarFields(entry: MessageLogEntry): void {
	if (
		!/^entry-[0-9a-f]{64}$/.test(String(entry.id)) ||
		!/^op-[0-9a-f]{64}$/.test(String((entry.operation as any)?.id))
	)
		throw new Error("invalid-message-log-id");
	if (typeof entry.occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.occurredAt))
		throw new Error("invalid-message-log-timestamp");
	const occurredAt = new Date(entry.occurredAt);
	if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== entry.occurredAt)
		throw new Error("invalid-message-log-timestamp");
	if (typeof entry.semanticFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(entry.semanticFingerprint))
		throw new Error("invalid-message-log-fingerprint");
}

function validateLifecycleContract(entry: MessageLogEntry): void {
	const allowedOutcomes = SURFACE_STAGE_OUTCOME[String(entry.surface)]?.[String(entry.stage)];
	if (!allowedOutcomes || !allowedOutcomes.has(String(entry.outcome)))
		throw new Error("invalid-message-log-surface-stage-outcome");
}
function operationFields(entry: MessageLogEntry): void {
	const operation = entry.operation as any;
	if (
		!operation ||
		typeof operation !== "object" ||
		Object.keys(operation).some((key) => !["id", "lifecycleSequence"].includes(key)) ||
		typeof operation.id !== "string" ||
		!Number.isSafeInteger(operation.lifecycleSequence) ||
		operation.lifecycleSequence < 1
	)
		throw new Error("invalid-message-log-operation");
}
const TEXT_KEYS = [
	"state",
	"reason",
	"text",
	"normalizedUtf8Bytes",
	"retainedUtf8Bytes",
	"omittedUtf8Bytes",
	"truncated",
	"escapedMarkerCount",
	"redactions",
];
function textShape(value: any): boolean {
	return (
		value &&
		typeof value === "object" &&
		Object.keys(value).every((key) => TEXT_KEYS.includes(key)) &&
		TEXT_KEYS.every((key) => key in value)
	);
}
function capturedText(value: any, maxBytes: number): boolean {
	return (
		value.state === "captured" &&
		value.reason === null &&
		typeof value.text === "string" &&
		new TextEncoder().encode(value.text).byteLength <= maxBytes &&
		textCounts(value)
	);
}
function unavailableText(value: any): boolean {
	return (
		value.state === "unavailable" &&
		["invalid-payload", "invalid-unicode", "unsupported-control", "record-capacity"].includes(value.reason) &&
		value.text === null &&
		value.normalizedUtf8Bytes === null &&
		value.omittedUtf8Bytes === null &&
		value.retainedUtf8Bytes === 0 &&
		value.truncated === false &&
		value.escapedMarkerCount === 0 &&
		Array.isArray(value.redactions) &&
		value.redactions.length === 0
	);
}
function textState(value: any, maxBytes: number): boolean {
	if (value.state === "captured")
		return (
			value.reason === null &&
			typeof value.text === "string" &&
			new TextEncoder().encode(value.text).byteLength <= maxBytes
		);
	return (
		value.state === "unavailable" &&
		["invalid-payload", "invalid-unicode", "unsupported-control", "record-capacity"].includes(value.reason) &&
		value.text === null &&
		value.normalizedUtf8Bytes === null &&
		value.omittedUtf8Bytes === null &&
		value.retainedUtf8Bytes === 0 &&
		value.truncated === false &&
		value.escapedMarkerCount === 0 &&
		Array.isArray(value.redactions) &&
		value.redactions.length === 0
	);
}
function redactionsValid(value: any): boolean {
	return (
		Array.isArray(value.redactions) &&
		value.redactions.every(
			(item: any) =>
				item &&
				(item.kind === "secret" || item.kind === "credential") &&
				Number.isSafeInteger(item.occurrences) &&
				item.occurrences > 0,
		)
	);
}
function textAccounting(value: any): boolean {
	return (
		Number.isSafeInteger(value.normalizedUtf8Bytes) &&
		Number.isSafeInteger(value.retainedUtf8Bytes) &&
		Number.isSafeInteger(value.omittedUtf8Bytes) &&
		value.normalizedUtf8Bytes >= 0 &&
		value.retainedUtf8Bytes >= 0 &&
		value.omittedUtf8Bytes >= 0 &&
		value.retainedUtf8Bytes + value.omittedUtf8Bytes === value.normalizedUtf8Bytes &&
		value.retainedUtf8Bytes === new TextEncoder().encode(value.text).byteLength &&
		typeof value.truncated === "boolean" &&
		value.truncated === value.omittedUtf8Bytes > 0 &&
		Number.isSafeInteger(value.escapedMarkerCount) &&
		value.escapedMarkerCount >= 0 &&
		redactionsValid(value)
	);
}
function textCounts(value: any): boolean {
	return value.state === "unavailable" || (textAccounting(value) && Array.isArray(value.redactions));
}
function textFields(value: any, maxBytes: number, allowUnavailable = true): boolean {
	return textShape(value) && (capturedText(value, maxBytes) || (allowUnavailable && unavailableText(value)));
}
function payloadShape(payload: any): boolean {
	return (
		payload &&
		typeof payload === "object" &&
		!Object.keys(payload).some(
			(key) => !["state", "reason", "content", "instructions", "instructionCount"].includes(key),
		) &&
		["represented", "unavailable"].includes(payload.state) &&
		Array.isArray(payload.instructions) &&
		payload.instructions.length <= 32
	);
}
function payloadTexts(payload: any): boolean {
	return payload.state === "represented"
		? payload.reason === null &&
				textFields(payload.content, 4096, false) &&
				payload.instructions.every((item: any) => textFields(item, 1024, false))
		: ["invalid-payload", "record-capacity"].includes(payload.reason) &&
				unavailableText(payload.content) &&
				payload.instructions.every((item: any) => unavailableText(item));
}
function payloadCount(payload: any): boolean {
	return payload.state === "represented"
		? Number.isSafeInteger(payload.instructionCount) && payload.instructionCount === payload.instructions.length
		: payload.reason === "invalid-payload"
			? payload.instructionCount === null && payload.instructions.length === 0
			: payload.reason === "record-capacity" &&
				Number.isSafeInteger(payload.instructionCount) &&
				payload.instructionCount === payload.instructions.length;
}
function payloadFields(entry: MessageLogEntry): void {
	const requiresPayload = payloadContract(String(entry.surface), String(entry.stage), String(entry.outcome));
	if (requiresPayload) {
		const payload = entry.payload as any;
		if (payload === null || !payloadShape(payload) || !payloadTexts(payload) || !payloadCount(payload))
			throw new Error("invalid-message-log-payload");
		return;
	}
	if (entry.payload !== null) throw new Error("invalid-message-log-payload");
}
function captureFields(entry: MessageLogEntry): void {
	const capture = entry.capture as any;
	const keys = ["endpointId", "epochId", "attemptSequence", "capturedAt"];
	if (
		!capture ||
		typeof capture !== "object" ||
		Object.keys(capture).some((key) => !keys.includes(key)) ||
		keys.some((key) => !(key in capture)) ||
		typeof capture.endpointId !== "string" ||
		typeof capture.epochId !== "string" ||
		!Number.isSafeInteger(capture.attemptSequence) ||
		capture.attemptSequence < 1 ||
		typeof capture.capturedAt !== "string"
	)
		throw new Error("invalid-message-log-capture");
	const capturedAt = new Date(capture.capturedAt);
	if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(capture.capturedAt))
		throw new Error("invalid-message-log-timestamp");
	if (Number.isNaN(capturedAt.getTime()) || capturedAt.toISOString() !== capture.capturedAt)
		throw new Error("invalid-message-log-timestamp");
}
function nestedFields(entry: MessageLogEntry): void {
	operationFields(entry);
	payloadFields(entry);
	captureFields(entry);
}
export function validateMessageLogEntry(entry: MessageLogEntry): void {
	requiredFields(entry);
	if (
		entry.version !== 1 ||
		entry.kind !== "message-event" ||
		!SURFACES.has(String(entry.surface)) ||
		!STAGES.has(String(entry.stage)) ||
		!OUTCOMES.has(String(entry.outcome)) ||
		(entry.outcome === "failed" ? typeof entry.errorCode !== "string" : entry.errorCode !== null)
	)
		throw new Error("invalid-message-log-schema");
	validateLifecycleContract(entry);
	closedFields(entry);
	scalarFields(entry);
	nestedFields(entry);
}

export function canonicalMessageLogJson(value: unknown): string {
	if (value === undefined || typeof value === "function" || typeof value === "symbol")
		throw new Error("invalid-message-log-value");
	if (typeof value === "number" && !Number.isFinite(value)) throw new Error("invalid-message-log-value");
	if (Array.isArray(value)) return `[${value.map(canonicalMessageLogJson).join(",")}]`;
	if (value && typeof value === "object") {
		const encoder = new TextEncoder();
		const keys = Object.keys(value as object).sort((a, b) =>
			Buffer.compare(Buffer.from(encoder.encode(a)), Buffer.from(encoder.encode(b))),
		);
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalMessageLogJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function canonicalMessageLogEntryBytes(entry: MessageLogEntry): Uint8Array {
	validateMessageLogEntry(entry);
	const ordered: Record<string, unknown> = {};
	for (const key of CANONICAL_KEYS) if (key in entry) ordered[key] = entry[key];
	return new TextEncoder().encode(`${canonicalMessageLogJson(ordered)}\n`);
}
