import type { RequestOutcome } from "../domain/member-request.ts";
import type { RetrospectiveEvidenceInterval, RetrospectiveEvidenceFingerprint } from "../domain/index.ts";
import {
	MAX_MEMBER_REPORT_RESPONSE_BYTES,
	type MemberSessionReport,
	parseMemberReportResponse,
	renderMemberReportEvidenceText,
	memberReportEvidenceId,
} from "../domain/member-report.ts";
import { createRetrospectiveEvidence } from "../domain/retrospective-evidence.ts";

/** TASK-0114: bounded Member session report collection over correlated Member requests. */

export const MEMBER_REPORT_COLLECTOR_ID = "bebop.member-report-collector";

export type MemberReportOutcomeKind =
	| "response-accepted"
	| "offline"
	| "timeout-max-wait"
	| "timeout-response-after-idle"
	| "idle-without-response"
	| "malformed"
	| "oversized"
	| "duplicate"
	| "late"
	| "restarted-unavailable";

export interface MemberReportRosterMember {
	readonly name: string;
	readonly role: string;
}

export type MemberReportSendRequest = (
	member: MemberReportRosterMember,
	request: { readonly message: string; readonly instructions: readonly string[] },
) => Promise<RequestOutcome>;

export interface MemberReportRequestPlan {
	readonly message: string;
	readonly instructions: readonly string[];
}

/** Builds the single bounded request sent to one roster member. */
export function buildMemberReportRequest(
	member: MemberReportRosterMember,
	retrospectiveId: string,
	interval: RetrospectiveEvidenceInterval,
): MemberReportRequestPlan {
	const message = [
		`${member.name}: please review your visible Crew-session work in the retrospective interval [${interval.start}, ${interval.end}).`,
		`Retrospective: ${retrospectiveId}`,
		"",
		"Return exactly one report in this closed sectioned format (every section required; empty sections allowed except observed-situations and impact):",
		"## observed-situations",
		"- what you observed (at least one bullet)",
		"## impact",
		"one short paragraph on impact",
		"## helped",
		"- what helped",
		"## friction-rework",
		"- friction or rework",
		"## changed-decisions",
		"- decisions you changed",
		"## missing-context",
		"- context you were missing",
		"## evidence-references",
		"- references to evidence (commits, reports, messages)",
		"",
		"Rules: no credentials or secrets (they are redacted); hidden reasoning is explicitly unavailable and must never be summarized; no Agreement proposal is requested or needed; do not claim another member's identity.",
	].join("\n");
	const instructions = [
		"Respond with exactly one report using the seven sectioned headings.",
		"Do not include credentials, secrets, or hidden reasoning.",
		"Attribution is taken from this request; do not attempt to report as another member.",
	];
	return { message, instructions };
}

export interface MemberReportRecordOutcome {
	readonly outcome: MemberReportOutcomeKind;
	/** true when a conflicting response arrived after an accepted report (original kept). */
	readonly conflict: boolean;
}

type MemberState =
	| {
			readonly state: "accepted";
			readonly report: MemberSessionReport;
			readonly requestId: string;
			readonly message: string;
	  }
	| { readonly state: Exclude<MemberReportOutcomeKind, "response-accepted" | "duplicate"> }
	| { readonly state: "pending" };

/**
 * Pure per-retrospective collection state. Retry/resume key is
 * retrospective/member/interval; the first accepted report is durable and can
 * only be superseded by nothing — later responses are duplicate/late/conflict.
 */
export class MemberReportCollection {
	private readonly members = new Map<string, MemberState>();

	constructor(
		private readonly retrospectiveId: string,
		private readonly interval: RetrospectiveEvidenceInterval,
	) {}

	private transition(member: string, state: MemberState): MemberState {
		this.members.set(member, state);
		return state;
	}

	recordMechanical(member: string, outcome: RequestOutcome): MemberReportRecordOutcome {
		const current = this.members.get(member);
		if (current?.state === "accepted") return { outcome: "duplicate", conflict: false };
		let outcomeKind: MemberReportOutcomeKind;
		if (outcome.kind === "offline") {
			this.transition(member, { state: "offline" });
			outcomeKind = "offline";
		} else if (outcome.kind === "timeout") {
			const state = outcome.reason === "max-wait" ? "timeout-max-wait" : "timeout-response-after-idle";
			this.transition(member, { state });
			outcomeKind = state;
		} else {
			// Response outcomes are handled by recordResponse; nothing to record here.
			return { outcome: "malformed", conflict: false };
		}
		return { outcome: outcomeKind, conflict: false };
	}

	recordIdleWithoutResponse(member: string): void {
		const current = this.members.get(member);
		if (current?.state === "accepted") return;
		this.transition(member, { state: "idle-without-response" });
	}

	recordMemberRestart(member: string): void {
		const current = this.members.get(member);
		if (current?.state === "accepted") return;
		this.transition(member, { state: "restarted-unavailable" });
	}

	recordResponse(
		member: string,
		requestId: string,
		message: string,
		options: { readonly receivedAfterWindowClosed?: boolean },
	): MemberReportRecordOutcome {
		const current = this.members.get(member);
		if (options.receivedAfterWindowClosed) {
			const conflict = current?.state === "accepted" && current.message !== message;
			// Late responses never replace or mutate the accepted report.
			if (current?.state !== "accepted") this.transition(member, { state: "late" });
			return { outcome: "late", conflict };
		}
		if (current?.state === "accepted") {
			return { outcome: "duplicate", conflict: current.message !== message };
		}
		if (Buffer.byteLength(message, "utf8") > MAX_MEMBER_REPORT_RESPONSE_BYTES) {
			this.transition(member, { state: "oversized" });
			return { outcome: "oversized", conflict: false };
		}
		const parsed = parseMemberReportResponse(message);
		if (!parsed.ok) {
			this.transition(member, { state: "malformed" });
			return { outcome: "malformed", conflict: false };
		}
		this.transition(member, { state: "accepted", report: parsed.report, requestId, message });
		return { outcome: "response-accepted", conflict: false };
	}

	reportForMember(member: string): MemberState | undefined {
		return this.members.get(member);
	}

	states(): ReadonlyMap<string, MemberState> {
		return new Map(this.members);
	}
}

/** Converts an accepted report to attributed evidence. Identity comes from the
 * Membership/request context (member name); report text can never change it. */
export function memberReportToEvidenceInput(
	report: MemberSessionReport,
	member: string,
	retrospectiveId: string,
	interval: RetrospectiveEvidenceInterval,
	requestId: string,
): ReturnType<typeof evidenceInputShape> {
	return evidenceInputShape(report, member, retrospectiveId, interval, requestId);
}

function evidenceInputShape(
	report: MemberSessionReport,
	member: string,
	retrospectiveId: string,
	interval: RetrospectiveEvidenceInterval,
	requestId: string,
) {
	return {
		id: memberReportEvidenceId(retrospectiveId, member, interval),
		interval,
		source: {
			kind: "member-retrospective-report" as const,
			identity: member,
			reference: requestId,
		},
		availability: "captured" as const,
		representation: { kind: "content" as const, text: renderMemberReportEvidenceText(report) },
		capture: {
			capturedAt: interval.start,
			collector: MEMBER_REPORT_COLLECTOR_ID,
			provenance: `member-retrospective-report.${retrospectiveId}.${member}`,
		},
	};
}

export interface MemberReportMemberResult {
	readonly member: string;
	readonly outcome: MemberReportOutcomeKind;
	readonly evidence?: ReturnType<typeof createRetrospectiveEvidence>;
}

/** Local self-report seam (Mary's A decision): the collecting member produces
 * its own report text locally — never through a remote correlated request. */
export interface MemberReportSelfReportSeam {
	/** Roster name of the member running this collector locally. */
	readonly member: string;
	/** Produces the member's own report text; the same strict parser applies. */
	produce(request: MemberReportRequestPlan): Promise<string>;
}

export class SelfRequestRejectedError extends Error {
	constructor(member: string) {
		super(`remote member-report request to self is rejected: ${member}`);
		this.name = "SelfRequestRejectedError";
	}
}

function selfReportRequestId(retrospectiveId: string, member: string): string {
	return `self-report.${retrospectiveId}.${member}`;
}

function assertRemoteMemberReportTarget(member: string, selfMember: string | undefined): void {
	if (selfMember !== undefined && member === selfMember) throw new SelfRequestRejectedError(member);
}

/** Options for one collection pass. */
export interface MemberReportCollectOptions {
	/** When set, this roster member reports through the local seam instead of
	 * a remote correlated request. */
	readonly selfReport?: MemberReportSelfReportSeam;
}

/**
 * One bounded pass over the roster in manifest order: exactly one correlated
 * Member request per remote member, and one local self-report for the member
 * running the collector (when configured). Accepted reports become attributed
 * evidence. Read-only apart from the injected seams; never activates Agreements.
 */
export async function collectMemberReports(
	roster: readonly MemberReportRosterMember[],
	retrospectiveId: string,
	interval: RetrospectiveEvidenceInterval,
	sendRequest: MemberReportSendRequest,
	fingerprint: RetrospectiveEvidenceFingerprint,
	options: MemberReportCollectOptions = {},
): Promise<readonly MemberReportMemberResult[]> {
	const collection = new MemberReportCollection(retrospectiveId, interval);
	const results: MemberReportMemberResult[] = [];
	for (const member of roster) {
		const plan = buildMemberReportRequest(member, retrospectiveId, interval);
		const isSelf = options.selfReport !== undefined && member.name === options.selfReport.member;
		let requestId: string;
		let message: string;
		if (isSelf) {
			requestId = selfReportRequestId(retrospectiveId, member.name);
			message = await options.selfReport!.produce(plan);
		} else {
			assertRemoteMemberReportTarget(member.name, options.selfReport?.member);
			const outcome = await sendRequest(member, plan);
			collection.recordMechanical(member.name, outcome);
			if (outcome.kind !== "response") {
				results.push({ member: member.name, outcome: mapMechanicalOutcome(outcome) });
				continue;
			}
			requestId = outcome.requestId;
			message = outcome.message;
		}
		const recorded = collection.recordResponse(member.name, requestId, message, {});
		results.push({
			member: member.name,
			outcome: recorded.outcome,
			evidence:
				recorded.outcome === "response-accepted"
					? createRetrospectiveEvidence(
							memberReportToEvidenceInput(
								(collection.reportForMember(member.name) as { report: MemberSessionReport }).report,
								member.name,
								retrospectiveId,
								interval,
								requestId,
							),
							fingerprint,
						)
					: undefined,
		});
	}
	return results;
}

function mapMechanicalOutcome(outcome: RequestOutcome): MemberReportOutcomeKind {
	if (outcome.kind === "offline") return "offline";
	if (outcome.kind === "timeout")
		return outcome.reason === "max-wait" ? "timeout-max-wait" : "timeout-response-after-idle";
	return "malformed";
}
