import type { RequestOutcome } from "../domain/member-request.ts";
import type { RetrospectiveEvidenceInterval } from "../domain/retrospective-evidence.ts";
import {
	CrewRetrospectiveFlow,
	buildRetrospectiveMemberRequest,
	type CrewRetrospectiveRoundState,
	type MemberRoundOutcome,
} from "../domain/crew-retrospective.ts";

/** TASK-0107: manual retrospective orchestration over the 0115 record.
 * Uses Follow-up/Member request semantics only; no Redirect/Interrupt;
 * no Agreement proposal/current/activation authority. */

export interface RetrospectiveReviewMember {
	readonly name: string;
	readonly role: string;
}

export interface RetrospectiveRoundDependencies {
	/** Read the frozen 0115 record identity/hash (integrity pre-check). */
	readonly readRecord: (recordId: string) => Promise<{ readonly id: string; readonly contentHash: string }>;
	/** Trusted active Membership identity and configured facilitator, when available. */
	readonly currentMemberName?: () => Promise<string>;
	readonly configuredFacilitator?: string;
	/** Read the current Crew Agreement activation state (0104/0105). */
	readonly readCurrentAgreementState: () => Promise<{
		readonly currentRevisionId: string;
		readonly currentContentHash: string;
	}>;
	/** Bounded pending Agreement proposal ids. */
	readonly listPendingProposalIds: () => Promise<readonly string[]>;
	/** Load the persisted open round for restart/resume (if any). */
	readonly loadOpenRound: (retrospectiveId: string) => Promise<CrewRetrospectiveRoundState | undefined>;
	/** Persist phase/IDs/request identities BEFORE any retryable effect. */
	readonly persistRound: (state: CrewRetrospectiveRoundState) => Promise<void>;
	/** Correlated Member request seam (never Redirect/Interrupt). */
	readonly sendRequest: (
		member: RetrospectiveReviewMember,
		request: { readonly requestId: string; readonly message: string; readonly instructions: readonly string[] },
	) => Promise<RequestOutcome>;
	/** Local facilitator review seam; self-RPC is forbidden by contract. */
	readonly localReview?: (
		member: RetrospectiveReviewMember,
		request: { readonly requestId: string; readonly message: string; readonly instructions: readonly string[] },
	) => Promise<RequestOutcome>;
}

export interface RetrospectiveRoundOpenInput {
	readonly retrospectiveId: string;
	/** Exact immutable 0115 record id. */
	readonly recordId?: string;
	readonly interval: RetrospectiveEvidenceInterval;
	readonly facilitator: string;
	readonly manifestRoster: readonly string[];
}

export interface RetrospectiveRoundOpenResult {
	readonly flow: CrewRetrospectiveFlow;
	readonly round: CrewRetrospectiveRoundState;
	readonly resumed: boolean;
}

/**
 * Explicit start of one Crew Retrospective round. Fails zero-write (no
 * requests, no round persistence) when the record or current agreement state
 * is stale, missing, or corrupt. Duplicate identical start is idempotent;
 * a different snapshot while a round is open is an explicit conflict.
 */
export async function openRetrospectiveRound(
	input: RetrospectiveRoundOpenInput,
	deps: RetrospectiveRoundDependencies,
): Promise<RetrospectiveRoundOpenResult> {
	// Authorization is Membership-backed when the trusted seam is configured;
	// facilitator arguments, Role, and claimed Origin are never authority.
	if (deps.configuredFacilitator !== undefined && input.facilitator !== deps.configuredFacilitator)
		throw new Error("facilitator is not the configured Member");
	if (deps.currentMemberName !== undefined) {
		const currentMember = await deps.currentMemberName();
		if (currentMember !== input.facilitator) throw new Error("current Membership is not facilitator");
	}
	// Integrity pre-check happens BEFORE any write or request.
	const record = await readRecordOrThrow(input.recordId ?? `retro-record.${input.retrospectiveId}`, deps);
	const current = await readCurrentStateOrThrow(deps);
	const pendingProposalIds = await deps.listPendingProposalIds();
	if (pendingProposalIds.length > 32) throw new Error("pending proposal snapshot exceeds bound");
	const openRound = await deps.loadOpenRound(input.retrospectiveId);
	if (openRound !== undefined) {
		// Duplicate start / restart resume: never resend, never duplicate.
		const flow = CrewRetrospectiveFlow.start({
			retrospectiveId: input.retrospectiveId,
			interval: input.interval,
			facilitator: input.facilitator,
			snapshot: {
				recordId: record.id,
				recordHash: record.contentHash,
				currentRevisionId: current.currentRevisionId,
				currentContentHash: current.currentContentHash,
				pendingProposalIds,
				roster: input.manifestRoster,
			},
			alreadyOpen: openRound,
		});
		return { flow, round: flow.round, resumed: true };
	}

	const flow = CrewRetrospectiveFlow.start({
		retrospectiveId: input.retrospectiveId,
		interval: input.interval,
		facilitator: input.facilitator,
		snapshot: {
			recordId: record.id,
			recordHash: record.contentHash,
			currentRevisionId: current.currentRevisionId,
			currentContentHash: current.currentContentHash,
			pendingProposalIds,
			roster: input.manifestRoster,
		},
	});
	// Persist the open round before any retryable effect (member requests).
	await deps.persistRound(flow.serialize());
	return { flow, round: flow.round, resumed: false };
}

/** Collect one logical review slot per frozen member. The facilitator uses
 * localReview; all others use one stable correlated request. */
export async function collectRetrospectiveReviews(
	flow: CrewRetrospectiveFlow,
	members: readonly RetrospectiveReviewMember[],
	deps: RetrospectiveRoundDependencies,
): Promise<CrewRetrospectiveRoundState> {
	const plan = buildRetrospectiveMemberRequest(flow.round.snapshot.recordId);
	const byName = new Map(members.map((member) => [member.name, member]));
	for (const memberName of flow.round.snapshot.roster) {
		if (flow.round.memberStates[memberName] !== undefined) continue;
		const member = byName.get(memberName);
		if (!member) {
			flow.recordOutcome(memberName, "missing");
			await deps.persistRound(flow.serialize());
			continue;
		}
		const request = { ...plan, requestId: flow.round.requestIds[memberName] };
		const outcome =
			memberName === flow.round.facilitator
				? await (deps.localReview?.(member, request) ??
						Promise.resolve({ kind: "offline", requestId: request.requestId, member } as RequestOutcome))
				: await deps.sendRequest(member, request);
		recordRequestOutcome(flow, memberName, outcome);
		await deps.persistRound(flow.serialize());
	}
	return flow.round;
}

function recordRequestOutcome(flow: CrewRetrospectiveFlow, member: string, outcome: RequestOutcome): void {
	if (outcome.kind === "response") {
		flow.recordResponse(member, outcome.requestId, outcome.message);
		return;
	}
	if (outcome.kind === "offline") {
		flow.recordOutcome(member, "offline");
		return;
	}
	const timeoutOutcome: MemberRoundOutcome =
		outcome.reason === "max-wait" ? "timeout-max-wait" : "timeout-response-after-idle";
	flow.recordOutcome(member, timeoutOutcome);
}

async function readRecordOrThrow(
	recordId: string,
	deps: RetrospectiveRoundDependencies,
): Promise<{ id: string; contentHash: string }> {
	try {
		const record = await deps.readRecord(recordId);
		if (!record.id || record.id !== recordId || !/^[a-f0-9]{64}$/.test(record.contentHash))
			throw new Error("record identity or hash is malformed");
		return record;
	} catch (error) {
		throw new Error(`retrospective record is missing or corrupt: ${String(error)}`, { cause: error });
	}
}

async function readCurrentStateOrThrow(deps: RetrospectiveRoundDependencies): Promise<{
	currentRevisionId: string;
	currentContentHash: string;
}> {
	try {
		const state = await deps.readCurrentAgreementState();
		if (!state.currentRevisionId || !/^[a-f0-9]{64}$/.test(state.currentContentHash))
			throw new Error("current agreement revision or hash is malformed");
		return state;
	} catch (error) {
		throw new Error(`current agreement state is missing or corrupt: ${String(error)}`, { cause: error });
	}
}
