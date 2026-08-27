import type { RetrospectiveEvidenceInterval } from "./retrospective-evidence.ts";

/** TASK-0107: manual Crew Retrospective round — orchestration state machine.
 * Coordinates only: no proposal/current/activation authority anywhere. */

export const CREW_RETROSPECTIVE_ROUND_VERSION = 1 as const;
export const MAX_PENDING_PROPOSAL_IDS = 32;
export const MAX_REVIEW_MATERIAL_ITEMS = 128;
export const MAX_REVIEW_NOTE_BYTES = 2048;
export const MAX_REVIEW_TARGET_BYTES = 128;

export type CrewRetrospectivePhase = "collecting" | "synthesizing" | "completed";

export type MemberRoundOutcome =
	| "response-received"
	| "offline"
	| "timeout-max-wait"
	| "timeout-response-after-idle"
	| "missing"
	| "malformed"
	| "late"
	| "duplicate";

export interface RoundSnapshotInput {
	readonly recordId: string;
	readonly recordHash: string;
	readonly currentRevisionId: string;
	readonly currentContentHash: string;
	readonly pendingProposalIds: readonly string[];
	readonly roster: readonly string[];
}

export interface RoundSnapshot extends RoundSnapshotInput {
	readonly pendingProposalIds: readonly string[];
	readonly roster: readonly string[];
}

export type ReviewMaterialKind = "correction" | "challenge" | "objection";

export interface ReviewMaterialItem {
	readonly member: string;
	readonly kind: ReviewMaterialKind;
	readonly target: string;
	readonly note: string;
}

export type CandidateStatus = "candidate" | "stale";

export interface CandidateRevisionState {
	readonly baseRevisionId: string;
	readonly baseRecordHash: string;
	readonly status: CandidateStatus;
}

export interface FacilitatorTakeover {
	readonly from: string;
	readonly to: string;
	readonly reason: string;
}

export interface ReviewResponse {
	readonly requestId: string;
	readonly message: string;
}

export interface CrewRetrospectiveRoundState {
	readonly version: typeof CREW_RETROSPECTIVE_ROUND_VERSION;
	readonly kind: "crew-retrospective-round";
	readonly id: string;
	readonly retrospectiveId: string;
	readonly interval: RetrospectiveEvidenceInterval;
	readonly facilitator: string;
	readonly phase: CrewRetrospectivePhase;
	readonly snapshot: RoundSnapshot;
	readonly memberStates: Readonly<Record<string, MemberRoundOutcome>>;
	/** Stable logical slot identity; one slot per frozen member. */
	readonly requestIds: Readonly<Record<string, string>>;
	/** Raw bounded responses are retained as attributed review input. */
	readonly responses: Readonly<Record<string, ReviewResponse>>;
	readonly reviewMaterial: readonly ReviewMaterialItem[];
	readonly candidate?: CandidateRevisionState;
	readonly facilitatorTakeover?: FacilitatorTakeover;
}

export class CrewRetrospectiveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CrewRetrospectiveError";
	}
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

function roundId(retrospectiveId: string, interval: RetrospectiveEvidenceInterval): string {
	return `retro-round.${safeSegment(retrospectiveId)}.${fnv1a32(`${interval.start}|${interval.end}`)}`;
}

export function retrospectiveRequestId(roundIdValue: string, member: string): string {
	return `retro-request.${safeSegment(roundIdValue)}.${fnv1a32(member)}`;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateSnapshot(snapshot: RoundSnapshotInput): RoundSnapshot {
	if (snapshot.roster.length === 0) throw new CrewRetrospectiveError("roster must not be empty");
	if (snapshot.roster.length !== new Set(snapshot.roster).size)
		throw new CrewRetrospectiveError("roster must not contain duplicates");
	if (!snapshot.recordId || !snapshot.recordHash || !snapshot.currentRevisionId || !snapshot.currentContentHash)
		throw new CrewRetrospectiveError("snapshot identity fields must be non-empty");
	if (snapshot.pendingProposalIds.length > MAX_PENDING_PROPOSAL_IDS)
		throw new CrewRetrospectiveError(`pending proposal ids exceed ${MAX_PENDING_PROPOSAL_IDS}`);
	return { ...snapshot, roster: [...snapshot.roster], pendingProposalIds: [...snapshot.pendingProposalIds] };
}

function validateFacilitator(name: string, roster: readonly string[]): void {
	if (!name || name.includes(":") || !roster.includes(name))
		throw new CrewRetrospectiveError(`facilitator must be an exact configured member name: ${name}`);
}

export interface StartRetrospectiveInput {
	readonly retrospectiveId: string;
	readonly interval: RetrospectiveEvidenceInterval;
	readonly facilitator: string;
	readonly snapshot: RoundSnapshotInput;
	/** Present when a round is already open for this retrospective. */
	readonly alreadyOpen?: CrewRetrospectiveRoundState;
}

/** Pure round state machine: explicit start, explicit outcomes, attributed
 * review material, base-matched candidate synthesis, deterministic completion. */
export class CrewRetrospectiveFlow {
	private constructor(
		private state: CrewRetrospectiveRoundState,
		private readonly originalSnapshot: RoundSnapshot,
	) {}

	static start(input: StartRetrospectiveInput): CrewRetrospectiveFlow {
		if (input.interval.end <= input.interval.start)
			throw new CrewRetrospectiveError("interval must satisfy start < end");
		const snapshot = validateSnapshot(input.snapshot);
		validateFacilitator(input.facilitator, snapshot.roster);
		const id = roundId(input.retrospectiveId, input.interval);
		if (input.alreadyOpen) {
			const open = input.alreadyOpen;
			const sameIdentity =
				open.id === id &&
				open.snapshot.recordId === snapshot.recordId &&
				open.snapshot.recordHash === snapshot.recordHash &&
				open.snapshot.currentRevisionId === snapshot.currentRevisionId &&
				open.snapshot.currentContentHash === snapshot.currentContentHash &&
				arraysEqual(open.snapshot.roster, snapshot.roster) &&
				arraysEqual(open.snapshot.pendingProposalIds, snapshot.pendingProposalIds);
			if (!sameIdentity)
				throw new CrewRetrospectiveError(
					`an open retrospective round exists with a different snapshot: ${open.id} (conflict)`,
				);
			return CrewRetrospectiveFlow.resume(open);
		}
		const requestIds: Record<string, string> = {};
		for (const member of snapshot.roster) requestIds[member] = retrospectiveRequestId(id, member);
		const state: CrewRetrospectiveRoundState = {
			version: CREW_RETROSPECTIVE_ROUND_VERSION,
			kind: "crew-retrospective-round",
			id,
			retrospectiveId: input.retrospectiveId,
			interval: input.interval,
			facilitator: input.facilitator,
			phase: "collecting",
			snapshot,
			memberStates: {},
			requestIds,
			responses: {},
			reviewMaterial: [],
		};
		return new CrewRetrospectiveFlow(state, snapshot);
	}

	static resume(state: CrewRetrospectiveRoundState): CrewRetrospectiveFlow {
		if (state.kind !== "crew-retrospective-round" || state.version !== CREW_RETROSPECTIVE_ROUND_VERSION)
			throw new CrewRetrospectiveError("not a crew retrospective round state");
		const snapshot = validateSnapshot(state.snapshot);
		const requestIds: Record<string, string> = { ...(state.requestIds ?? {}) };
		for (const member of snapshot.roster) requestIds[member] ??= retrospectiveRequestId(state.id, member);
		return new CrewRetrospectiveFlow(
			{ ...state, snapshot, requestIds, responses: state.responses ?? {} },
			snapshot,
		);
	}

	get round(): CrewRetrospectiveRoundState {
		return {
			...this.state,
			memberStates: { ...this.state.memberStates },
			requestIds: { ...this.state.requestIds },
			responses: { ...this.state.responses },
			reviewMaterial: [...this.state.reviewMaterial],
		};
	}

	get contentFingerprint(): string {
		return fnv1a32(JSON.stringify(this.state));
	}

	serialize(): CrewRetrospectiveRoundState {
		return this.round;
	}

	private assertOpen(): void {
		if (this.state.phase === "completed") throw new CrewRetrospectiveError("round is terminal (completed)");
	}

	private assertMember(member: string): void {
		if (!this.state.snapshot.roster.includes(member))
			throw new CrewRetrospectiveError(`not a frozen roster member: ${member}`);
	}

	recordOutcome(member: string, outcome: MemberRoundOutcome): void {
		this.assertOpen();
		this.assertMember(member);
		if (this.state.responses[member] !== undefined) {
			this.state = { ...this.state, memberStates: { ...this.state.memberStates, [member]: "duplicate" } };
			return;
		}
		this.state = { ...this.state, memberStates: { ...this.state.memberStates, [member]: outcome } };
	}

	recordResponse(member: string, requestId: string, message: string): void {
		this.assertOpen();
		this.assertMember(member);
		if (requestId !== this.state.requestIds[member])
			throw new CrewRetrospectiveError("request correlation mismatch");
		if (message.length === 0 || Buffer.byteLength(message, "utf8") > MAX_REVIEW_NOTE_BYTES)
			throw new CrewRetrospectiveError("response exceeds byte bound");
		if (this.state.responses[member] !== undefined) {
			this.state = { ...this.state, memberStates: { ...this.state.memberStates, [member]: "duplicate" } };
			return;
		}
		this.state = {
			...this.state,
			memberStates: { ...this.state.memberStates, [member]: "response-received" },
			responses: { ...this.state.responses, [member]: { requestId, message } },
		};
	}

	appendCorrection(member: string, evidenceId: string, note: string): void {
		this.appendReview(member, "correction", evidenceId, note);
	}

	appendChallenge(member: string, situationId: string, note: string): void {
		this.appendReview(member, "challenge", situationId, note);
	}

	appendObjection(member: string, note: string): void {
		this.appendReview(member, "objection", "", note);
	}

	private appendReview(member: string, kind: ReviewMaterialKind, target: string, note: string): void {
		this.assertOpen();
		this.assertMember(member);
		if (this.state.reviewMaterial.length >= MAX_REVIEW_MATERIAL_ITEMS)
			throw new CrewRetrospectiveError(`review material exceeds ${MAX_REVIEW_MATERIAL_ITEMS} items`);
		if (target.length > MAX_REVIEW_TARGET_BYTES)
			throw new CrewRetrospectiveError("review target exceeds byte bound");
		if (note.length === 0 || Buffer.byteLength(note, "utf8") > MAX_REVIEW_NOTE_BYTES)
			throw new CrewRetrospectiveError("review note exceeds byte bound");
		this.state = {
			...this.state,
			reviewMaterial: [...this.state.reviewMaterial, { member, kind, target, note }],
		};
	}

	synthesizeCandidate(input: {
		readonly baseRevisionId: string;
		readonly baseRecordHash: string;
		readonly operations: readonly unknown[];
	}): void {
		this.assertOpen();
		// The retrospective can produce at most ONE candidate revision; its base
		// must match the snapshot exactly. Stale bases never merge or rebase.
		const status: CandidateStatus =
			input.baseRevisionId === this.originalSnapshot.currentRevisionId &&
			input.baseRecordHash === this.originalSnapshot.recordHash
				? "candidate"
				: "stale";
		this.state = {
			...this.state,
			phase: "synthesizing",
			candidate: {
				baseRevisionId: input.baseRevisionId,
				baseRecordHash: input.baseRecordHash,
				status,
			},
		};
	}

	takeover(newFacilitator: string, reason: string): void {
		this.assertOpen();
		if (!reason || reason.length === 0) throw new CrewRetrospectiveError("takeover requires an explicit reason");
		validateFacilitator(newFacilitator, this.state.snapshot.roster);
		this.state = {
			...this.state,
			facilitator: newFacilitator,
			facilitatorTakeover: { from: this.state.facilitator, to: newFacilitator, reason },
		};
	}

	complete(): CrewRetrospectiveRoundState {
		this.assertOpen();
		const memberStates: Record<string, MemberRoundOutcome> = { ...this.state.memberStates };
		for (const member of this.state.snapshot.roster) {
			if (memberStates[member] === undefined) memberStates[member] = "missing";
		}
		const completed: CrewRetrospectiveRoundState = { ...this.state, memberStates, phase: "completed" };
		this.state = completed;
		return this.round;
	}
}

export interface RetrospectiveMemberRequestPlan {
	readonly message: string;
	readonly instructions: readonly string[];
}

/** One bounded request sent to every frozen roster member: identical record
 * identity and identical question set for everyone. */
export function buildRetrospectiveMemberRequest(recordId: string): RetrospectiveMemberRequestPlan {
	const message = [
		`Crew Retrospective record: ${recordId}`,
		"",
		"Please review and respond covering exactly these topics:",
		"1. evidence correction — any evidence you believe is wrong, with the evidence id",
		"2. interpretation challenge — any situation interpretation you dispute, with the situation id",
		"3. Start/Stop/Continue — what to start, stop, and continue as a crew",
		"4. current/Trial Agreement review — comments on current and trial agreements",
		"5. objections — any objection you want recorded",
		"",
		"No response is required to consent to anything; missing responses are recorded as missing, never as agreement.",
	].join("\n");
	const instructions = [
		"Respond once covering all five topics.",
		"Cite exact evidence or situation ids when correcting or challenging.",
		"Corrections and challenges are appended as attributed review material; they never mutate the record.",
	];
	return { message, instructions };
}
