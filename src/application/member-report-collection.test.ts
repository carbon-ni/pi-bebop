import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RequestOutcome } from "../domain/member-request.ts";
import type { RetrospectiveEvidenceInterval, RetrospectiveEvidence } from "../domain/index.ts";
import {
	MemberReportCollection,
	buildMemberReportRequest,
	collectMemberReports,
	type MemberReportSendRequest,
	memberReportToEvidenceInput,
	type MemberReportRosterMember,
} from "./member-report-collection.ts";

const INTERVAL: RetrospectiveEvidenceInterval = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
const RETRO = "retro-1";

const VALID_REPORT_TEXT = [
	"## observed-situations",
	"- gate failed twice",
	"",
	"## impact",
	"blocked two hours",
	"",
	"## helped",
	"- matrix caught regression",
	"",
	"## friction-rework",
	"",
	"## changed-decisions",
	"",
	"## missing-context",
	"",
	"## evidence-references",
	"- commit:3bdffe9",
].join("\n");

const OTHER_VALID_REPORT_TEXT = VALID_REPORT_TEXT.replace("gate failed twice", "gate failed once");

const MALFORMED_TEXT = "not a report at all";

function response(member: string, message: string): RequestOutcome {
	return {
		kind: "response",
		requestId: `req-${member}`,
		member: { name: member, role: "role" },
		message,
		instructions: [],
	};
}

function roster(names: readonly string[]): readonly MemberReportRosterMember[] {
	return names.map((name) => ({ name, role: `${name}-role` }));
}

function makeSend(outcomes: Record<string, RequestOutcome>): {
	send: MemberReportSendRequest;
	calls: Map<string, number>;
} {
	const calls = new Map<string, number>();
	const send: MemberReportSendRequest = async (member) => {
		calls.set(member.name, (calls.get(member.name) ?? 0) + 1);
		return outcomes[member.name] ?? offlineOutcome(member.name);
	};
	return { send, calls };
}

function offlineOutcome(member: string): RequestOutcome {
	return { kind: "offline", requestId: `req-${member}`, member: { name: member, role: "role" } };
}

function timeoutOutcome(member: string, reason: "max-wait" | "response-after-idle"): RequestOutcome {
	return { kind: "timeout", requestId: `req-${member}`, member: { name: member, role: "role" }, reason };
}

const FIXED_FINGERPRINT = () => "a".repeat(64);

describe("buildMemberReportRequest", () => {
	it("builds one bounded request naming the member and exact interval", () => {
		const request = buildMemberReportRequest({ name: "Mary", role: "po" }, RETRO, INTERVAL);
		assert.ok(request.message.includes("Mary"));
		assert.ok(request.message.includes(INTERVAL.start));
		assert.ok(request.message.includes(INTERVAL.end));
		assert.ok(request.message.includes("## observed-situations"));
		assert.ok(request.instructions.length > 0);
	});

	it("asks for the closed section schema and forbids extra sections", () => {
		const request = buildMemberReportRequest({ name: "Dave", role: "dev" }, RETRO, INTERVAL);
		for (const section of [
			"observed-situations",
			"impact",
			"helped",
			"friction-rework",
			"changed-decisions",
			"missing-context",
			"evidence-references",
		]) {
			assert.ok(request.message.includes(section));
		}
		assert.ok(request.message.toLowerCase().includes("hidden reasoning"));
	});
});

describe("MemberReportCollection state machine", () => {
	it("accepts a valid response and exposes attributed evidence input", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		const result = collection.recordResponse("Mary", "req-Mary", VALID_REPORT_TEXT, {});
		assert.equal(result.outcome, "response-accepted");
		const accepted = collection.reportForMember("Mary");
		assert.equal(accepted?.state, "accepted");
		const evidence = memberReportToEvidenceInput(accepted.report, "Mary", RETRO, INTERVAL, "req-Mary");
		assert.equal(evidence.source.kind, "member-retrospective-report");
		assert.equal(evidence.source.identity, "Mary");
		assert.equal(evidence.source.reference, "req-Mary");
		assert.ok(evidence.representation?.text.includes("observed-situations"));
	});

	it("maps offline to explicit outcome without fabricating a report", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		const result = collection.recordMechanical("Mary", offlineOutcome("Mary"));
		assert.equal(result.outcome, "offline");
		assert.equal(collection.reportForMember("Mary")?.state, "offline");
	});

	it("keeps timeout reasons distinct", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		assert.equal(
			collection.recordMechanical("Mary", timeoutOutcome("Mary", "max-wait")).outcome,
			"timeout-max-wait",
		);
		const other = new MemberReportCollection(RETRO, INTERVAL);
		assert.equal(
			other.recordMechanical("Mary", timeoutOutcome("Mary", "response-after-idle")).outcome,
			"timeout-response-after-idle",
		);
	});

	it("records idle-without-response explicitly", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		collection.recordIdleWithoutResponse("Mary");
		assert.equal(collection.reportForMember("Mary")?.state, "idle-without-response");
	});

	it("records member restart explicitly", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		collection.recordMemberRestart("Mary");
		assert.equal(collection.reportForMember("Mary")?.state, "restarted-unavailable");
	});

	it("malformed response never becomes a report", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		const result = collection.recordResponse("Mary", "req-Mary", MALFORMED_TEXT, {});
		assert.equal(result.outcome, "malformed");
		assert.equal(collection.reportForMember("Mary")?.state, "malformed");
	});

	it("oversized response is explicit", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		const huge = `${VALID_REPORT_TEXT}\n\n## extra-padding\n- ${"x".repeat(70 * 1024)}`;
		const result = collection.recordResponse("Mary", "req-Mary", huge, {});
		assert.equal(result.outcome, "oversized");
	});

	it("exact duplicate response is idempotent replay, original kept", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		collection.recordResponse("Mary", "req-Mary", VALID_REPORT_TEXT, {});
		const second = collection.recordResponse("Mary", "req-Mary", VALID_REPORT_TEXT, {});
		assert.equal(second.outcome, "duplicate");
		assert.equal(second.conflict, false);
		const accepted = collection.reportForMember("Mary");
		assert.equal(accepted?.state, "accepted");
		assert.ok(accepted.report.observedSituations.includes("gate failed twice"));
	});

	it("conflicting later response is stable conflict, never replaces the accepted report", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		collection.recordResponse("Mary", "req-Mary", VALID_REPORT_TEXT, {});
		const second = collection.recordResponse("Mary", "req-Mary-2", OTHER_VALID_REPORT_TEXT, {});
		assert.equal(second.outcome, "duplicate");
		assert.equal(second.conflict, true);
		const accepted = collection.reportForMember("Mary");
		assert.equal(accepted?.state, "accepted");
		assert.ok(accepted.report.observedSituations.includes("gate failed twice"));
	});

	it("late response is explicit and does not replace accepted report", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		collection.recordResponse("Mary", "req-Mary", VALID_REPORT_TEXT, {});
		const late = collection.recordResponse("Mary", "req-Mary-2", OTHER_VALID_REPORT_TEXT, {
			receivedAfterWindowClosed: true,
		});
		assert.equal(late.outcome, "late");
		const accepted = collection.reportForMember("Mary");
		assert.equal(accepted?.state, "accepted");
	});

	it("late response without prior acceptance records late outcome", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		const late = collection.recordResponse("Mary", "req-Mary", VALID_REPORT_TEXT, {
			receivedAfterWindowClosed: true,
		});
		assert.equal(late.outcome, "late");
		assert.equal(collection.reportForMember("Mary")?.state, "late");
	});

	it("mechanical outcomes do not override an accepted report", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		collection.recordResponse("Mary", "req-Mary", VALID_REPORT_TEXT, {});
		const after = collection.recordMechanical("Mary", offlineOutcome("Mary"));
		assert.equal(after.outcome, "duplicate");
		const accepted = collection.reportForMember("Mary");
		assert.equal(accepted?.state, "accepted");
	});

	it("no cross-member leakage: each member keyed independently", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		collection.recordResponse("Mary", "req-Mary", VALID_REPORT_TEXT, {});
		collection.recordResponse("Dave", "req-Dave", OTHER_VALID_REPORT_TEXT, {});
		const mary = collection.reportForMember("Mary");
		const dave = collection.reportForMember("Dave");
		assert.equal(mary?.state, "accepted");
		assert.equal(dave?.state, "accepted");
		assert.ok(mary.report.observedSituations.includes("gate failed twice"));
		assert.ok(dave.report.observedSituations.includes("gate failed once"));
	});

	it("member names are derived from request context, not report text", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		// response text claims to be someone else; attribution stays Mary
		const spoof = VALID_REPORT_TEXT.replace("gate failed twice", "I am actually Dave");
		const result = collection.recordResponse("Mary", "req-Mary", spoof, {});
		assert.equal(result.outcome, "response-accepted");
		const evidence = memberReportToEvidenceInput(
			collection.reportForMember("Mary").report,
			"Mary",
			RETRO,
			INTERVAL,
			"req-Mary",
		);
		assert.equal(evidence.source.identity, "Mary");
		assert.ok(!evidence.source.identity.includes("Dave"));
	});
});

describe("collectMemberReports orchestration", () => {
	it("collects full roster with accepted responses in manifest order", async () => {
		const { send, calls } = makeSend({
			Mary: response("Mary", VALID_REPORT_TEXT),
			Dave: response("Dave", OTHER_VALID_REPORT_TEXT),
		});
		const results = await collectMemberReports(roster(["Mary", "Dave"]), RETRO, INTERVAL, send, FIXED_FINGERPRINT);
		assert.deepEqual(
			results.map((r) => r.member),
			["Mary", "Dave"],
		);
		assert.ok(results.every((r) => r.outcome === "response-accepted"));
		assert.ok(results.every((r) => r.evidence !== undefined));
		for (const member of ["Mary", "Dave"]) assert.equal(calls.get(member), 1);
	});

	it("partial roster: offline member gets explicit outcome, no report fabricated", async () => {
		const { send } = makeSend({
			Mary: response("Mary", VALID_REPORT_TEXT),
			Dave: offlineOutcome("Dave"),
		});
		const results = await collectMemberReports(roster(["Mary", "Dave"]), RETRO, INTERVAL, send, FIXED_FINGERPRINT);
		assert.equal(results[0]!.outcome, "response-accepted");
		assert.equal(results[1]!.outcome, "offline");
		assert.equal(results[1]!.evidence, undefined);
	});

	it("each terminal outcome maps distinctly", async () => {
		const cases: Array<[RequestOutcome, string]> = [
			[offlineOutcome("M"), "offline"],
			[timeoutOutcome("M", "max-wait"), "timeout-max-wait"],
			[timeoutOutcome("M", "response-after-idle"), "timeout-response-after-idle"],
			[response("M", MALFORMED_TEXT), "malformed"],
		];
		for (const [outcome, expected] of cases) {
			const { send } = makeSend({ M: outcome });
			const results = await collectMemberReports(roster(["M"]), RETRO, INTERVAL, send, FIXED_FINGERPRINT);
			assert.equal(results[0]!.outcome, expected, `expected ${expected}`);
		}
	});

	it("sends exactly one request per member — no message beyond the request", async () => {
		const { send, calls } = makeSend({ Mary: response("Mary", VALID_REPORT_TEXT) });
		await collectMemberReports(roster(["Mary"]), RETRO, INTERVAL, send, FIXED_FINGERPRINT);
		assert.equal(calls.get("Mary"), 1);
	});

	it("accepted reports produce stable attributed evidence with deterministic ids", async () => {
		const { send } = makeSend({ Mary: response("Mary", VALID_REPORT_TEXT) });
		const results = await collectMemberReports(roster(["Mary"]), RETRO, INTERVAL, send, FIXED_FINGERPRINT);
		const evidence = results[0]!.evidence!;
		assert.equal(evidence.id, "member-report.retro-1.Mary." + evidence.id.split(".").pop());
		const rerun = await collectMemberReports(roster(["Mary"]), RETRO, INTERVAL, send, FIXED_FINGERPRINT);
		assert.equal(rerun[0]!.evidence!.id, evidence.id);
		assert.equal(rerun[0]!.evidence!.fingerprint, evidence.fingerprint);
	});
});

describe("evidence conversion properties", () => {
	it("representation uses labeled sections (interpretation explicit)", () => {
		const collection = new MemberReportCollection(RETRO, INTERVAL);
		collection.recordResponse("Mary", "req-Mary", VALID_REPORT_TEXT, {});
		const accepted = collection.reportForMember("Mary");
		const evidence = memberReportToEvidenceInput(accepted.report, "Mary", RETRO, INTERVAL, "req-Mary");
		for (const label of [
			"observed-situations:",
			"impact:",
			"helped:",
			"friction-rework:",
			"changed-decisions:",
			"missing-context:",
			"evidence-references:",
		]) {
			assert.ok(evidence.representation?.text.includes(label), label);
		}
	});

	it("evidence availability is captured with provenance and member attribution", async () => {
		const { send } = makeSend({ Mary: response("Mary", VALID_REPORT_TEXT) });
		const results = await collectMemberReports(roster(["Mary"]), RETRO, INTERVAL, send, FIXED_FINGERPRINT);
		const evidence = results[0]!.evidence!;
		assert.equal(evidence.availability, "captured");
		assert.ok(evidence.capture.collector.includes("member-report"));
		assert.ok(evidence.capture.provenance.includes(RETRO));
		assert.ok(evidence.capture.provenance.includes("Mary"));
	});
});

describe("no agreement/activation surface", () => {
	it("module has no crew-agreements imports (source-level check)", async () => {
		const fs = await import("node:fs");
		const source = fs.readFileSync("src/application/member-report-collection.ts", "utf8");
		assert.ok(!source.includes("crew-agreements"));
		assert.ok(!source.includes("activateAgreement"));
	});
});
