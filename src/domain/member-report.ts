import {
	redactRetrospectiveEvidenceText,
	type RetrospectiveEvidenceInterval,
	type RetrospectiveEvidenceRedaction,
} from "./retrospective-evidence.ts";

/** TASK-0114: bounded Member session report schema and parsing. */

export const MAX_MEMBER_REPORT_SECTION_ITEMS = 16;
export const MAX_MEMBER_REPORT_ITEM_BYTES = 2048;
export const MAX_MEMBER_REPORT_IMPACT_BYTES = 2048;
export const MAX_MEMBER_REPORT_TOTAL_BYTES = 64 * 1024;
export const MAX_MEMBER_REPORT_RESPONSE_BYTES = 64 * 1024;

export const MEMBER_REPORT_SECTIONS = [
	"observed-situations",
	"impact",
	"helped",
	"friction-rework",
	"changed-decisions",
	"missing-context",
	"evidence-references",
] as const;

export type MemberReportSection = (typeof MEMBER_REPORT_SECTIONS)[number];

export const MEMBER_REPORT_LIST_SECTIONS: readonly MemberReportSection[] = [
	"observed-situations",
	"helped",
	"friction-rework",
	"changed-decisions",
	"missing-context",
	"evidence-references",
];

export interface MemberSessionReport {
	readonly observedSituations: readonly string[];
	readonly impact: string;
	readonly helped: readonly string[];
	readonly frictionRework: readonly string[];
	readonly changedDecisions: readonly string[];
	readonly missingContext: readonly string[];
	readonly evidenceReferences: readonly string[];
	readonly redactions: readonly RetrospectiveEvidenceRedaction[];
}

export type MemberReportParseCode =
	| "malformed"
	| "missing-section"
	| "empty-required-section"
	| "unknown-section"
	| "duplicate-section"
	| "nul-byte"
	| "oversized"
	| "item-too-large"
	| "impact-too-large"
	| "too-many-items"
	| "empty-item";

export type MemberReportParseResult =
	| { readonly ok: true; readonly report: MemberSessionReport }
	| { readonly ok: false; readonly code: MemberReportParseCode };

const SECTION_HEADER = /^## ([a-z-]+)$/;
const LIST_ITEM = /^- (.*)$/;

function isMemberReportSection(value: string): value is MemberReportSection {
	return (MEMBER_REPORT_SECTIONS as readonly string[]).includes(value);
}

function mergeRedactions(entries: readonly RetrospectiveEvidenceRedaction[]): RetrospectiveEvidenceRedaction[] {
	const byKind = new Map<string, RetrospectiveEvidenceRedaction>();
	for (const entry of entries) {
		const existing = byKind.get(entry.kind);
		if (existing) {
			byKind.set(entry.kind, { ...existing, occurrences: existing.occurrences + entry.occurrences });
		} else {
			byKind.set(entry.kind, { ...entry });
		}
	}
	return [...byKind.values()];
}

/**
 * Parses a Member session report from the correlated Response message text.
 * Strict sectioned format: every section must be present; observed-situations
 * and impact must be non-empty; all items redacted for credentials/secrets.
 */
export function parseMemberReportResponse(text: string): MemberReportParseResult {
	if (text.trim().length === 0) return { ok: false, code: "malformed" };
	if (text.includes(String.fromCharCode(0))) return { ok: false, code: "nul-byte" };
	if (Buffer.byteLength(text, "utf8") > MAX_MEMBER_REPORT_RESPONSE_BYTES) return { ok: false, code: "oversized" };

	const sections = new Map<MemberReportSection, string[]>();
	let current: MemberReportSection | undefined;
	const redactionEntries: RetrospectiveEvidenceRedaction[] = [];

	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const header = SECTION_HEADER.exec(line);
		if (header) {
			const marked = markSectionHeader(sections, header[1]!);
			if ("code" in marked) return { ok: false, code: marked.code };
			current = marked.section;
			continue;
		}
		if (current === undefined) {
			if (line.trim().length > 0) return { ok: false, code: "malformed" };
			continue;
		}
		if (line.trim().length === 0) continue;
		const code = appendSectionEntry(sections.get(current)!, current, line, redactionEntries);
		if (code !== undefined) return { ok: false, code };
	}

	const required = validateRequiredSections(sections);
	if (required !== undefined) return { ok: false, code: required };

	const impact = buildImpact(sections);
	if (typeof impact === "string") return { ok: false, code: impact };
	redactionEntries.push(...impact.impactRedactionEntries);

	const report: MemberSessionReport = {
		observedSituations: sections.get("observed-situations")!,
		impact: impact.impactText,
		helped: sections.get("helped")!,
		frictionRework: sections.get("friction-rework")!,
		changedDecisions: sections.get("changed-decisions")!,
		missingContext: sections.get("missing-context")!,
		evidenceReferences: sections.get("evidence-references")!,
		redactions: mergeRedactions(redactionEntries),
	};
	return { ok: true, report };
}

function markSectionHeader(
	sections: Map<MemberReportSection, string[]>,
	name: string,
): { section: MemberReportSection } | { code: MemberReportParseCode } {
	if (!isMemberReportSection(name)) return { code: "unknown-section" };
	if (sections.has(name)) return { code: "duplicate-section" };
	sections.set(name, []);
	return { section: name };
}

function validateRequiredSections(sections: Map<MemberReportSection, string[]>): MemberReportParseCode | undefined {
	for (const section of MEMBER_REPORT_SECTIONS) {
		if (!sections.has(section)) return "missing-section";
	}
	if ((sections.get("observed-situations") ?? []).length === 0) return "empty-required-section";
	if ((sections.get("impact") ?? []).length === 0) return "empty-required-section";
	return undefined;
}

function buildImpact(
	sections: Map<MemberReportSection, string[]>,
): { impactText: string; impactRedactionEntries: readonly RetrospectiveEvidenceRedaction[] } | MemberReportParseCode {
	const impactLines = sections.get("impact")!;
	if (impactLines.length > MAX_MEMBER_REPORT_SECTION_ITEMS) return "too-many-items";
	const impactJoined = impactLines.join(" ");
	if (Buffer.byteLength(impactJoined, "utf8") > MAX_MEMBER_REPORT_IMPACT_BYTES) return "impact-too-large";
	const impactRedacted = redactRetrospectiveEvidenceText(impactJoined);
	return { impactText: impactRedacted.text, impactRedactionEntries: impactRedacted.redactions };
}

function appendSectionEntry(
	entries: string[],
	section: MemberReportSection,
	line: string,
	redactionEntries: RetrospectiveEvidenceRedaction[],
): MemberReportParseCode | undefined {
	if (/^[-*]\s*$/.test(line)) return "empty-item";
	const value = extractEntryValue(section, line);
	if (value === undefined) return "malformed";
	if (value.length === 0) return "empty-item";
	if (entries.length >= MAX_MEMBER_REPORT_SECTION_ITEMS) return "too-many-items";
	if (Buffer.byteLength(value, "utf8") > MAX_MEMBER_REPORT_ITEM_BYTES) return "item-too-large";
	const redacted = redactRetrospectiveEvidenceText(value);
	redactionEntries.push(...redacted.redactions);
	entries.push(redacted.text);
	return undefined;
}

function extractEntryValue(section: MemberReportSection, line: string): string | undefined {
	if ((MEMBER_REPORT_LIST_SECTIONS as readonly string[]).includes(section)) {
		const item = LIST_ITEM.exec(line);
		return item ? (item[1]!.trim() as string) : undefined;
	}
	// impact: prose paragraph lines
	return line.trim();
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

/** Structural check without JSON-schema machinery: exact fields, no extras. */
export function isMemberSessionReport(value: unknown): value is MemberSessionReport {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	const expectedKeys = [
		"observedSituations",
		"impact",
		"helped",
		"frictionRework",
		"changedDecisions",
		"missingContext",
		"evidenceReferences",
		"redactions",
	];
	if (Object.keys(record).length !== expectedKeys.length) return false;
	for (const key of expectedKeys) {
		if (!(key in record)) return false;
	}
	const listFields: readonly (keyof MemberSessionReport)[] = [
		"observedSituations",
		"helped",
		"frictionRework",
		"changedDecisions",
		"missingContext",
		"evidenceReferences",
	];
	for (const field of listFields) {
		if (!isStringArray(record[field as string])) return false;
	}
	if (typeof record.impact !== "string" || record.impact.length === 0) return false;
	return isRedactionArray(record.redactions);
}

function isRedactionArray(value: unknown): value is readonly RetrospectiveEvidenceRedaction[] {
	if (!Array.isArray(value)) return false;
	for (const redaction of value) {
		if (typeof redaction !== "object" || redaction === null) return false;
		const entry = redaction as Record<string, unknown>;
		if (entry.kind !== "credential" && entry.kind !== "secret") return false;
		if (typeof entry.marker !== "string" || typeof entry.occurrences !== "number") return false;
		if (!Number.isInteger(entry.occurrences) || entry.occurrences < 1) return false;
	}
	return true;
}

function renderList(label: string, items: readonly string[]): string {
	if (items.length === 0) return `${label}: (none)`;
	return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

/** Renders the report as labeled evidence text: every interpretation label is explicit. */
export function renderMemberReportEvidenceText(report: MemberSessionReport): string {
	const parts = [
		renderList("observed-situations", report.observedSituations),
		`impact: ${report.impact}`,
		renderList("helped", report.helped),
		renderList("friction-rework", report.frictionRework),
		renderList("changed-decisions", report.changedDecisions),
		renderList("missing-context", report.missingContext),
		renderList("evidence-references", report.evidenceReferences),
	];
	return parts.join("\n\n");
}

function fnv1a32(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function safeSegment(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
	return cleaned.length > 0 ? cleaned : "unknown";
}

/** Stable retry/resume key: retrospective/member/interval. */
export function memberReportCollectionKey(
	retrospectiveId: string,
	member: string,
	interval: RetrospectiveEvidenceInterval,
): string {
	return `${retrospectiveId}|${member}|${interval.start}|${interval.end}`;
}

/** Deterministic, path-safe evidence id for one member report. */
export function memberReportEvidenceId(
	retrospectiveId: string,
	member: string,
	interval: RetrospectiveEvidenceInterval,
): string {
	const intervalKey = fnv1a32(`${interval.start}|${interval.end}`);
	return `member-report.${safeSegment(retrospectiveId)}.${safeSegment(member)}.${intervalKey}`;
}
