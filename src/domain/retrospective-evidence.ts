import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const RETROSPECTIVE_EVIDENCE_VERSION = 1 as const;
export const MAX_RETROSPECTIVE_EVIDENCE_ID_BYTES = 128;
export const MAX_RETROSPECTIVE_EVIDENCE_REFERENCE_BYTES = 2 * 1024;
export const MAX_RETROSPECTIVE_EVIDENCE_TEXT_BYTES = 64 * 1024;
export const MAX_RETROSPECTIVE_EVIDENCE_REDACTION_KINDS = 2;

const NonEmptyText = Type.String({ minLength: 1 });
const RetrospectiveEvidenceSourceKindSchema = Type.Union([
	Type.Literal("bebop-coordination"),
	Type.Literal("repository-artifact"),
	Type.Literal("member-retrospective-report"),
	Type.Literal("member-observation"),
]);
const RetrospectiveEvidenceAvailabilitySchema = Type.Union([
	Type.Literal("captured"),
	Type.Literal("unavailable"),
	Type.Literal("unsupported"),
]);
const RetrospectiveEvidenceRedactionKindSchema = Type.Union([Type.Literal("credential"), Type.Literal("secret")]);

export const RetrospectiveEvidenceIntervalSchema = Type.Object(
	{ start: NonEmptyText, end: NonEmptyText },
	{ additionalProperties: false },
);
export const RetrospectiveEvidenceSourceSchema = Type.Object(
	{ kind: RetrospectiveEvidenceSourceKindSchema, identity: NonEmptyText, reference: NonEmptyText },
	{ additionalProperties: false },
);
export const RetrospectiveEvidenceRepresentationSchema = Type.Object(
	{ kind: Type.Union([Type.Literal("content"), Type.Literal("summary")]), text: NonEmptyText },
	{ additionalProperties: false },
);
export const RetrospectiveEvidenceGapSchema = Type.Object({ reason: NonEmptyText }, { additionalProperties: false });
export const RetrospectiveEvidenceRedactionSchema = Type.Object(
	{
		kind: RetrospectiveEvidenceRedactionKindSchema,
		marker: Type.Union([Type.Literal("[REDACTED:credential]"), Type.Literal("[REDACTED:secret]")]),
		occurrences: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export const RetrospectiveEvidenceCaptureSchema = Type.Object(
	{ capturedAt: NonEmptyText, collector: NonEmptyText, provenance: NonEmptyText },
	{ additionalProperties: false },
);
export const RetrospectiveEvidenceSchema = Type.Object(
	{
		version: Type.Literal(RETROSPECTIVE_EVIDENCE_VERSION),
		kind: Type.Literal("retrospective-evidence"),
		id: NonEmptyText,
		interval: RetrospectiveEvidenceIntervalSchema,
		source: RetrospectiveEvidenceSourceSchema,
		availability: RetrospectiveEvidenceAvailabilitySchema,
		representation: Type.Optional(RetrospectiveEvidenceRepresentationSchema),
		gap: Type.Optional(RetrospectiveEvidenceGapSchema),
		redactions: Type.Array(RetrospectiveEvidenceRedactionSchema, {
			maxItems: MAX_RETROSPECTIVE_EVIDENCE_REDACTION_KINDS,
		}),
		capture: RetrospectiveEvidenceCaptureSchema,
		fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	},
	{ additionalProperties: false },
);

export type RetrospectiveEvidenceSourceKind = Static<typeof RetrospectiveEvidenceSourceKindSchema>;
export type RetrospectiveEvidenceAvailability = Static<typeof RetrospectiveEvidenceAvailabilitySchema>;
export type RetrospectiveEvidenceInterval = Static<typeof RetrospectiveEvidenceIntervalSchema>;
export type RetrospectiveEvidenceSource = Static<typeof RetrospectiveEvidenceSourceSchema>;
export type RetrospectiveEvidenceRepresentation = Static<typeof RetrospectiveEvidenceRepresentationSchema>;
export type RetrospectiveEvidenceGap = Static<typeof RetrospectiveEvidenceGapSchema>;
export type RetrospectiveEvidenceRedaction = Static<typeof RetrospectiveEvidenceRedactionSchema>;
export type RetrospectiveEvidenceCapture = Static<typeof RetrospectiveEvidenceCaptureSchema>;
export type RetrospectiveEvidence = Static<typeof RetrospectiveEvidenceSchema>;
export type RetrospectiveEvidenceFingerprint = (canonicalInput: string) => string;
export interface RetrospectiveEvidenceInput {
	readonly id: string;
	readonly interval: RetrospectiveEvidenceInterval;
	readonly source: RetrospectiveEvidenceSource;
	readonly availability: RetrospectiveEvidenceAvailability;
	readonly representation?: RetrospectiveEvidenceRepresentation;
	readonly gap?: RetrospectiveEvidenceGap;
	readonly capture: RetrospectiveEvidenceCapture;
}

export type RetrospectiveEvidenceConflictCode = "id-conflict" | "fingerprint-conflict";
export class RetrospectiveEvidenceConflictError extends Error {
	readonly code: RetrospectiveEvidenceConflictCode;
	constructor(code: RetrospectiveEvidenceConflictCode, message: string) {
		super(message);
		this.name = "RetrospectiveEvidenceConflictError";
		this.code = code;
	}
}

const textEncoder = new TextEncoder();
const REDACTION_MARKERS = {
	credential: "[REDACTED:credential]",
	secret: "[REDACTED:secret]",
} as const;

function utf8Bytes(value: string): number {
	return textEncoder.encode(value).byteLength;
}
function validText(value: string, maxBytes: number): boolean {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value === value.trim() &&
		!value.includes("\0") &&
		utf8Bytes(value) <= maxBytes
	);
}
function validId(value: string): boolean {
	return validText(value, MAX_RETROSPECTIVE_EVIDENCE_ID_BYTES) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
function validUtcInstant(value: string): boolean {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const instant = new Date(value);
	return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value;
}
function validInterval(interval: RetrospectiveEvidenceInterval): boolean {
	return validUtcInstant(interval.start) && validUtcInstant(interval.end) && interval.start < interval.end;
}
function redactionTextFields(evidence: RetrospectiveEvidence): readonly string[] {
	return [
		evidence.representation?.text,
		evidence.gap?.reason,
		evidence.source.identity,
		evidence.source.reference,
		evidence.capture.collector,
		evidence.capture.provenance,
	].filter((value): value is string => value !== undefined);
}
function validAvailabilityShape(
	evidence: Pick<RetrospectiveEvidence, "availability" | "representation" | "gap">,
): boolean {
	if (evidence.availability === "captured")
		return evidence.representation !== undefined && evidence.gap === undefined;
	return evidence.representation === undefined && evidence.gap !== undefined;
}
function markerOccurrences(values: readonly string[], marker: string): number {
	return values.reduce((total, value) => total + value.split(marker).length - 1, 0);
}
function summarizeRedactions(values: readonly string[]): RetrospectiveEvidenceRedaction[] {
	return (Object.keys(REDACTION_MARKERS) as Array<keyof typeof REDACTION_MARKERS>).flatMap((kind) => {
		const marker = REDACTION_MARKERS[kind];
		const occurrences = markerOccurrences(values, marker);
		return occurrences === 0 ? [] : [{ kind, marker, occurrences }];
	});
}
function validRedactions(evidence: RetrospectiveEvidence): boolean {
	const kinds = evidence.redactions.map(({ kind }) => kind);
	if (new Set(kinds).size !== kinds.length) return false;
	const expected = summarizeRedactions(redactionTextFields(evidence));
	return canonicalRetrospectiveEvidenceJson(evidence.redactions) === canonicalRetrospectiveEvidenceJson(expected);
}

/** Stable canonical JSON excludes no object keys except undefined optionals. */
export function canonicalRetrospectiveEvidenceJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalRetrospectiveEvidenceJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value as Record<string, unknown>)
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalRetrospectiveEvidenceJson((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Capture provenance and local record IDs are excluded so independent collectors deduplicate one source event. */
export function canonicalRetrospectiveEvidenceFingerprintInput(
	evidence: Pick<
		RetrospectiveEvidence,
		"version" | "kind" | "interval" | "source" | "availability" | "representation" | "gap" | "redactions"
	>,
): string {
	return canonicalRetrospectiveEvidenceJson({
		version: evidence.version,
		kind: evidence.kind,
		interval: evidence.interval,
		source: evidence.source,
		availability: evidence.availability,
		representation: evidence.representation,
		gap: evidence.gap,
	});
}

function replaceSensitiveText(
	text: string,
	pattern: RegExp,
	replacement: string | ((substring: string, ...args: string[]) => string),
): string {
	return text.replace(pattern, (...args: unknown[]) => {
		if (typeof replacement === "string") return replacement;
		return replacement(args[0] as string, ...(args.slice(1, -2) as string[]));
	});
}

/** Deterministic bounded redaction. It does not hide ordinary visible Crew work. */
export function redactRetrospectiveEvidenceText(value: string): {
	readonly text: string;
	readonly redactions: readonly RetrospectiveEvidenceRedaction[];
} {
	let text = value;
	const apply = (pattern: RegExp, replacement: string | ((substring: string, ...args: string[]) => string)) => {
		text = replaceSensitiveText(text, pattern, replacement);
	};
	apply(
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
		REDACTION_MARKERS.secret,
	);
	apply(
		/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@/\s]+)@/gi,
		(_match, scheme) => `${scheme}${REDACTION_MARKERS.credential}@`,
	);
	apply(
		/\b(authorization\s*:\s*bearer)\s+([A-Za-z0-9._~+/=-]{6,})/gi,
		(_match, prefix) => `${prefix} ${REDACTION_MARKERS.credential}`,
	);
	apply(
		/\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
		(_match, key, separator) => `${key}${separator}${REDACTION_MARKERS.credential}`,
	);
	apply(/\bAKIA[0-9A-Z]{16}\b/g, REDACTION_MARKERS.credential);
	return { text, redactions: summarizeRedactions([text]) };
}

function validSourceAndCapture(evidence: RetrospectiveEvidence): boolean {
	const references = [
		evidence.source.identity,
		evidence.source.reference,
		evidence.capture.collector,
		evidence.capture.provenance,
	];
	return (
		references.every((value) => validText(value, MAX_RETROSPECTIVE_EVIDENCE_REFERENCE_BYTES)) &&
		validUtcInstant(evidence.capture.capturedAt)
	);
}
function validEvidencePayload(evidence: RetrospectiveEvidence): boolean {
	const representationValid =
		evidence.representation === undefined ||
		validText(evidence.representation.text, MAX_RETROSPECTIVE_EVIDENCE_TEXT_BYTES);
	const gapValid =
		evidence.gap === undefined || validText(evidence.gap.reason, MAX_RETROSPECTIVE_EVIDENCE_TEXT_BYTES);
	return validAvailabilityShape(evidence) && representationValid && gapValid && validRedactions(evidence);
}

export function isRetrospectiveEvidence(value: unknown): value is RetrospectiveEvidence {
	if (!Value.Check(RetrospectiveEvidenceSchema, value)) return false;
	const evidence = value as RetrospectiveEvidence;
	if (!validId(evidence.id) || !validInterval(evidence.interval)) return false;
	if (!validSourceAndCapture(evidence) || !validEvidencePayload(evidence)) return false;
	return utf8Bytes(canonicalRetrospectiveEvidenceJson(evidence)) <= MAX_RETROSPECTIVE_EVIDENCE_TEXT_BYTES * 2;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
	return Object.freeze(value);
}

export function parseRetrospectiveEvidence(value: unknown): RetrospectiveEvidence {
	if (!isRetrospectiveEvidence(value)) throw new TypeError("invalid Retrospective evidence");
	return deepFreeze(value);
}

function validInputSchema(input: RetrospectiveEvidenceInput): boolean {
	const representationValid =
		input.representation === undefined ||
		Value.Check(RetrospectiveEvidenceRepresentationSchema, input.representation);
	const gapValid = input.gap === undefined || Value.Check(RetrospectiveEvidenceGapSchema, input.gap);
	return (
		Value.Check(RetrospectiveEvidenceIntervalSchema, input.interval) &&
		Value.Check(RetrospectiveEvidenceSourceSchema, input.source) &&
		Value.Check(RetrospectiveEvidenceCaptureSchema, input.capture) &&
		Value.Check(RetrospectiveEvidenceAvailabilitySchema, input.availability) &&
		representationValid &&
		gapValid
	);
}
function validInputBounds(input: RetrospectiveEvidenceInput): boolean {
	const references = [
		input.source.identity,
		input.source.reference,
		input.capture.collector,
		input.capture.provenance,
	];
	const payload = input.representation?.text ?? input.gap?.reason ?? "";
	return (
		validId(input.id) &&
		validInterval(input.interval) &&
		validUtcInstant(input.capture.capturedAt) &&
		references.every((value) => validText(value, MAX_RETROSPECTIVE_EVIDENCE_REFERENCE_BYTES)) &&
		validText(payload, MAX_RETROSPECTIVE_EVIDENCE_TEXT_BYTES)
	);
}
function validRetrospectiveEvidenceInput(input: RetrospectiveEvidenceInput): boolean {
	if (!validInputSchema(input) || !validInputBounds(input)) return false;
	return validAvailabilityShape({
		availability: input.availability,
		representation: input.representation,
		gap: input.gap,
	});
}

export function createRetrospectiveEvidence(
	input: RetrospectiveEvidenceInput,
	fingerprint: RetrospectiveEvidenceFingerprint,
): RetrospectiveEvidence {
	if (!validRetrospectiveEvidenceInput(input)) throw new TypeError("invalid Retrospective evidence input");
	const redact = (value: string): string => redactRetrospectiveEvidenceText(value).text;
	const source = {
		...input.source,
		identity: redact(input.source.identity),
		reference: redact(input.source.reference),
	};
	const capture = {
		...input.capture,
		collector: redact(input.capture.collector),
		provenance: redact(input.capture.provenance),
	};
	const representation =
		input.representation === undefined
			? undefined
			: { kind: input.representation.kind, text: redact(input.representation.text) };
	const gap = input.gap === undefined ? undefined : { reason: redact(input.gap.reason) };
	const redactions = summarizeRedactions(
		[
			representation?.text,
			gap?.reason,
			source.identity,
			source.reference,
			capture.collector,
			capture.provenance,
		].filter((value): value is string => value !== undefined),
	);
	const withoutFingerprint = {
		version: RETROSPECTIVE_EVIDENCE_VERSION,
		kind: "retrospective-evidence" as const,
		id: input.id,
		interval: { ...input.interval },
		source,
		availability: input.availability,
		...(representation === undefined ? {} : { representation }),
		...(gap === undefined ? {} : { gap }),
		redactions,
		capture,
	};
	const evidence = {
		...withoutFingerprint,
		fingerprint: fingerprint(canonicalRetrospectiveEvidenceFingerprintInput(withoutFingerprint)),
	};
	return parseRetrospectiveEvidence(evidence);
}

export function isTimestampInRetrospectiveInterval(
	timestamp: string,
	interval: RetrospectiveEvidenceInterval,
): boolean {
	return (
		validUtcInstant(timestamp) && validInterval(interval) && timestamp >= interval.start && timestamp < interval.end
	);
}

function compareEvidence(a: RetrospectiveEvidence, b: RetrospectiveEvidence): number {
	return `${a.interval.start}:${a.source.kind}:${a.fingerprint}:${a.id}`.localeCompare(
		`${b.interval.start}:${b.source.kind}:${b.fingerprint}:${b.id}`,
	);
}

export function orderAndDeduplicateRetrospectiveEvidence(
	values: readonly RetrospectiveEvidence[],
): readonly RetrospectiveEvidence[] {
	const ordered = values.map(parseRetrospectiveEvidence).sort(compareEvidence);
	const ids = new Map<string, string>();
	const fingerprints = new Map<string, string>();
	const result: RetrospectiveEvidence[] = [];
	for (const evidence of ordered) {
		const recordBytes = canonicalRetrospectiveEvidenceJson(evidence);
		const priorId = ids.get(evidence.id);
		if (priorId !== undefined && priorId !== recordBytes)
			throw new RetrospectiveEvidenceConflictError(
				"id-conflict",
				`Retrospective evidence ID contains conflicting immutable records: ${evidence.id}`,
			);
		ids.set(evidence.id, recordBytes);
		const fingerprintInput = canonicalRetrospectiveEvidenceFingerprintInput(evidence);
		const priorFingerprint = fingerprints.get(evidence.fingerprint);
		if (priorFingerprint !== undefined) {
			if (priorFingerprint !== fingerprintInput)
				throw new RetrospectiveEvidenceConflictError(
					"fingerprint-conflict",
					`Retrospective evidence fingerprint maps to conflicting events: ${evidence.fingerprint}`,
				);
			continue;
		}
		fingerprints.set(evidence.fingerprint, fingerprintInput);
		result.push(evidence);
	}
	return result;
}
