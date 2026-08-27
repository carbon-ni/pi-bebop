import {
	buildRetrospectiveDueReminder,
	deriveRetrospectiveSchedule,
	emptyRetrospectiveSchedule,
	recordRetrospectiveCompletion,
	retrospectiveReminderId,
	validateRetrospectiveScheduleState,
	type RetrospectiveScheduleResult,
	type RetrospectiveScheduleState,
	type CrewMember,
	type CrewRetrospectiveConfig,
	type MessagePayload,
} from "../domain/index.ts";

/** TASK-0108: finite-boundary cadence checks. No timer, polling, or round start. */
export interface RetrospectiveScheduleMembership {
	readonly manifestPath: string;
	readonly member: CrewMember;
	readonly manifest: {
		readonly members: readonly CrewMember[];
		readonly crewAgreements?: { readonly retrospective?: CrewRetrospectiveConfig };
	};
}

export interface RetrospectiveScheduleDependencies {
	readonly readState: () => Promise<unknown | null>;
	readonly persistState: (state: RetrospectiveScheduleState) => Promise<void>;
	/** Durable Inbox enqueue; the implementation must preserve `id` on retry. */
	readonly enqueueReminder: (
		target: CrewMember,
		payload: MessagePayload,
		id: string,
	) => Promise<"persisted" | "already-persisted">;
	readonly now: () => number;
	readonly openRound: () => Promise<boolean>;
}

export type RetrospectiveReminderResult = "not-needed" | "persisted" | "already-persisted" | "unavailable" | "failed";

export interface RetrospectiveScheduleCheckResult {
	readonly schedule: RetrospectiveScheduleResult;
	readonly reminder: RetrospectiveReminderResult;
}

function configOf(membership: RetrospectiveScheduleMembership): CrewRetrospectiveConfig | undefined {
	return membership.manifest.crewAgreements?.retrospective;
}

function findFacilitator(membership: RetrospectiveScheduleMembership, name: string): CrewMember | undefined {
	return membership.manifest.members.find((member) => member.name === name);
}

function reminderPayload(marker: NonNullable<RetrospectiveScheduleState["dueMarker"]>): MessagePayload {
	const reminder = buildRetrospectiveDueReminder(marker);
	return { content: reminder.message, instructions: [...reminder.instructions] };
}

/**
 * Checks one schedule at an explicit lifecycle boundary. It persists the due
 * marker before any Inbox effect, and never starts/contacts a round.
 */
export async function checkRetrospectiveSchedule(
	membership: RetrospectiveScheduleMembership,
	dependencies: RetrospectiveScheduleDependencies,
): Promise<RetrospectiveScheduleCheckResult> {
	const loaded = await dependencies.readState();
	const state = loaded === null ? emptyRetrospectiveSchedule() : validateRetrospectiveScheduleState(loaded);
	const config = configOf(membership);
	const facilitatorName = config?.facilitator ?? membership.member.name;
	const facilitator = findFacilitator(membership, facilitatorName);
	const schedule = deriveRetrospectiveSchedule({
		config,
		state,
		now: dependencies.now(),
		openRound: await dependencies.openRound(),
		facilitatorExists: facilitator !== undefined,
	});

	if (JSON.stringify(schedule.state) !== JSON.stringify(state)) await dependencies.persistState(schedule.state);
	if (schedule.status !== "due" || !schedule.state.dueMarker) return { schedule, reminder: "not-needed" };
	if (!facilitator) return { schedule, reminder: "unavailable" };
	try {
		const result = await dependencies.enqueueReminder(
			facilitator,
			reminderPayload(schedule.state.dueMarker),
			retrospectiveReminderId(schedule.state.dueMarker),
		);
		return { schedule, reminder: result };
	} catch {
		// The marker remains durable. A later finite boundary retries the same id.
		return { schedule, reminder: "failed" };
	}
}

/** Explicit completion boundary. Completion, not reminder handoff, advances cadence. */
export async function completeRetrospectiveSchedule(
	dependencies: Pick<RetrospectiveScheduleDependencies, "readState" | "persistState">,
	completedAt: number,
): Promise<RetrospectiveScheduleState> {
	const loaded = await dependencies.readState();
	if (loaded === null) throw new Error("retrospective schedule state is missing");
	const next = recordRetrospectiveCompletion(validateRetrospectiveScheduleState(loaded), completedAt);
	await dependencies.persistState(next);
	return next;
}
