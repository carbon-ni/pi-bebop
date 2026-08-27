import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_MEMBER_REPORT_SECTION_ITEMS,
	MAX_MEMBER_REPORT_ITEM_BYTES,
	MAX_MEMBER_REPORT_TOTAL_BYTES,
	MAX_MEMBER_REPORT_RESPONSE_BYTES,
	MEMBER_REPORT_SECTIONS,
	type MemberSessionReport,
	parseMemberReportResponse,
	renderMemberReportEvidenceText,
	memberReportEvidenceId,
	memberReportCollectionKey,
	isMemberSessionReport,
} from "./member-report.ts";

const VALID_RESPONSE = `## observed-situations
- Release gate failed twice on format checks

## impact
Blocked Mary's task for two hours

## helped
- Kelly's acceptance matrix caught the regression

## friction-rework
- Had to rerun the full suite three times

## changed-decisions
- Switched to focused test runs before full gates

## missing-context
- No ownership map for the shared worktree

## evidence-references
- commit:3bdffe9
- .tmp/reports/27-08-26/task-0114-member-reports-acceptance-matrix.md`;

const MINIMAL_RESPONSE = `## observed-situations
- nothing blocked

## impact
none

## helped

## friction-rework

## changed-decisions

## missing-context

## evidence-references`;

function assertValidReport(report: MemberSessionReport): void {
	assert.equal(isMemberSessionReport(report), true);
}

describe("member-report response parsing", () => {
	it("parses a complete valid response", () => {
		const result = parseMemberReportResponse(VALID_RESPONSE);
		assert.equal(result.ok, true);
		if (result.ok) {
			assertValidReport(result.report);
			assert.equal(result.report.observedSituations.length, 1);
			assert.equal(result.report.impact, "Blocked Mary's task for two hours");
			assert.equal(result.report.helped.length, 1);
			assert.equal(result.report.frictionRework.length, 1);
			assert.equal(result.report.changedDecisions.length, 1);
			assert.equal(result.report.missingContext.length, 1);
			assert.equal(result.report.evidenceReferences.length, 2);
		}
	});

	it("parses a minimal response with empty optional sections", () => {
		const result = parseMemberReportResponse(MINIMAL_RESPONSE);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.report.observedSituations.length, 1);
			assert.equal(result.report.helped.length, 0);
			assert.equal(result.report.evidenceReferences.length, 0);
		}
	});

	it("rejects missing required observed-situations section", () => {
		const text = `## impact
none`;
		const result = parseMemberReportResponse(text);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "missing-section");
	});

	it("rejects missing impact section", () => {
		const text = `## observed-situations
- something`;
		const result = parseMemberReportResponse(text);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "missing-section");
	});

	it("rejects empty observed-situations", () => {
		const text = [
			"## observed-situations",
			"",
			"## impact",
			"none",
			"",
			"## helped",
			"",
			"## friction-rework",
			"",
			"## changed-decisions",
			"",
			"## missing-context",
			"",
			"## evidence-references",
		].join("\n");
		const result = parseMemberReportResponse(text);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "empty-required-section");
	});

	it("rejects unknown section", () => {
		const text = VALID_RESPONSE + "\n\n## sentiment\n- felt great";
		const result = parseMemberReportResponse(text);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "unknown-section");
	});

	it("rejects duplicate section", () => {
		const text = `${VALID_RESPONSE}\n\n## impact\nsecond impact`;
		const result = parseMemberReportResponse(text);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "duplicate-section");
	});

	it("rejects NUL bytes", () => {
		const withNul = [
			"## observed-situations",
			"- ba" + String.fromCharCode(0) + "d item",
			"",
			"## impact none",
		].join("\n");
		const result = parseMemberReportResponse(withNul);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "nul-byte");
	});

	it("rejects item exceeding per-item byte bound", () => {
		const big = "y".repeat(MAX_MEMBER_REPORT_ITEM_BYTES + 1);
		const result = parseMemberReportResponse(`## observed-situations\n- ${big}\n\n## impact\nnone`);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "item-too-large");
	});

	it("rejects sections exceeding item count bound", () => {
		const items = Array.from({ length: MAX_MEMBER_REPORT_SECTION_ITEMS + 1 }, (_, i) => `- item ${i}`).join("\n");
		const result = parseMemberReportResponse(`## observed-situations\n${items}\n\n## impact\nnone`);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "too-many-items");
	});

	it("rejects malformed content without any section header", () => {
		const result = parseMemberReportResponse("just some text");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "malformed");
	});

	it("rejects empty response", () => {
		const result = parseMemberReportResponse("");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "malformed");
	});

	it("accepts exactly the section count bound", () => {
		const items = Array.from({ length: MAX_MEMBER_REPORT_SECTION_ITEMS }, (_, i) => `- item ${i}`).join("\n");
		const text = [
			"## observed-situations",
			items,
			"",
			"## impact",
			"none",
			"",
			"## helped",
			"",
			"## friction-rework",
			"",
			"## changed-decisions",
			"",
			"## missing-context",
			"",
			"## evidence-references",
		].join("\n");
		const result = parseMemberReportResponse(text);
		assert.equal(result.ok, true);
	});

	it("rejects empty list items (blank bullets)", () => {
		const text = [
			"## observed-situations",
			"-",
			"- real item",
			"",
			"## impact",
			"none",
			"",
			"## helped",
			"",
			"## friction-rework",
			"",
			"## changed-decisions",
			"",
			"## missing-context",
			"",
			"## evidence-references",
		].join("\n");
		const result = parseMemberReportResponse(text);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "empty-item");
	});
});

describe("member-report redaction", () => {
	it("redacts credential-like content in every section", () => {
		const text = `## observed-situations
- token=ghp_supersecretvalue leaked in logs

## impact
token=ghp_supersecretvalue exposed

## helped

## friction-rework

## changed-decisions

## missing-context

## evidence-references`;
		const result = parseMemberReportResponse(text);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.ok(!JSON.stringify(result.report).includes("ghp_supersecretvalue"));
			assert.ok(result.report.redactions.length >= 1);
			assert.equal(result.report.redactions[0]!.kind, "credential");
		}
	});
});

describe("member-report evidence rendering", () => {
	it("renders labeled sections so interpretation is explicit", () => {
		const result = parseMemberReportResponse(VALID_RESPONSE);
		assert.equal(result.ok, true);
		if (result.ok) {
			const rendered = renderMemberReportEvidenceText(result.report);
			assert.ok(rendered.includes("observed-situations:"));
			assert.ok(rendered.includes("impact:"));
			assert.ok(rendered.includes("helped:"));
			assert.ok(rendered.includes("friction-rework:"));
			assert.ok(rendered.includes("changed-decisions:"));
			assert.ok(rendered.includes("missing-context:"));
			assert.ok(rendered.includes("evidence-references:"));
		}
	});

	it("bounds rendered text within evidence limits", () => {
		const result = parseMemberReportResponse(VALID_RESPONSE);
		assert.equal(result.ok, true);
		if (result.ok) {
			const rendered = renderMemberReportEvidenceText(result.report);
			assert.ok(Buffer.byteLength(rendered, "utf8") <= MAX_MEMBER_REPORT_TOTAL_BYTES);
		}
	});
});

describe("member-report stable identity", () => {
	it("derives deterministic evidence ids from retrospective/member/interval", () => {
		const interval = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
		const a = memberReportEvidenceId("retro-1", "Mary", interval);
		const b = memberReportEvidenceId("retro-1", "Mary", interval);
		assert.equal(a, b);
		assert.match(a, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
	});

	it("distinct member or interval or retrospective yields distinct id", () => {
		const interval = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
		const other = { start: "2026-01-02T00:00:00.000Z", end: "2026-01-02T01:00:00.000Z" };
		const base = memberReportEvidenceId("retro-1", "Mary", interval);
		assert.notEqual(base, memberReportEvidenceId("retro-1", "Dave", interval));
		assert.notEqual(base, memberReportEvidenceId("retro-2", "Mary", interval));
		assert.notEqual(base, memberReportEvidenceId("retro-1", "Mary", other));
	});

	it("collection key is retrospective/member/interval", () => {
		const interval = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
		assert.equal(
			memberReportCollectionKey("retro-1", "Mary", interval),
			memberReportCollectionKey("retro-1", "Mary", interval),
		);
		assert.notEqual(
			memberReportCollectionKey("retro-1", "Mary", interval),
			memberReportCollectionKey("retro-1", "Dave", interval),
		);
	});
});

describe("isMemberSessionReport", () => {
	it("accepts a parsed report", () => {
		const result = parseMemberReportResponse(VALID_RESPONSE);
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(isMemberSessionReport(result.report), true);
	});

	it("rejects objects with unknown fields", () => {
		const result = parseMemberReportResponse(VALID_RESPONSE);
		assert.equal(result.ok, true);
		if (result.ok) {
			const extended = { ...result.report, sentiment: "great" } as unknown;
			assert.equal(isMemberSessionReport(extended), false);
		}
	});

	it("rejects null and primitives", () => {
		assert.equal(isMemberSessionReport(null), false);
		assert.equal(isMemberSessionReport("report"), false);
		assert.equal(isMemberSessionReport(42), false);
	});
});

describe("section vocabulary is closed", () => {
	it("exposes exactly the seven schema sections", () => {
		assert.deepEqual([...MEMBER_REPORT_SECTIONS].sort(), [
			"changed-decisions",
			"evidence-references",
			"friction-rework",
			"helped",
			"impact",
			"missing-context",
			"observed-situations",
		]);
	});
});
