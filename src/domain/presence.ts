export const DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD = 2;

export type PresenceStatus = "unknown" | "online" | "suspect" | "offline";
/** Immutable configured socketPath identity; display name and role are descriptive only. */
export type PresenceMember = { readonly identity: string; readonly name: string; readonly role: string };
export type PresenceConfig = { readonly notifications: boolean };
export type PresenceState = {
	readonly members: Readonly<Record<string, PresenceStatus>>;
	readonly failures: Readonly<Record<string, number>>;
	readonly initialScanComplete: boolean;
	readonly config: PresenceConfig;
};
export type PresenceEffect =
	| { readonly type: "roster"; readonly members: readonly (PresenceMember & { readonly status: PresenceStatus })[] }
	| { readonly type: "joined" | "left"; readonly member: PresenceMember };
export type PresenceEvent =
	| { readonly type: "observation"; readonly memberIdentity: string; readonly online: boolean }
	| { readonly type: "initial-scan-complete" };
export type PresenceReducerInput = {
	readonly members: readonly PresenceMember[];
	readonly currentMemberIdentity?: string;
	readonly event: PresenceEvent;
};
export type PresenceReducerResult = { readonly state: PresenceState; readonly effects: readonly PresenceEffect[] };

const DEFAULT_CONFIG: PresenceConfig = Object.freeze({ notifications: true });

export function createInitialPresenceState(
	members: readonly PresenceMember[],
	currentMemberIdentity?: string,
	config: PresenceConfig = DEFAULT_CONFIG,
): PresenceState {
	const included = members.filter((member) => member.identity !== currentMemberIdentity);
	return {
		members: Object.fromEntries(included.map((member) => [member.identity, "unknown" as const])),
		failures: Object.fromEntries(included.map((member) => [member.identity, 0])),
		initialScanComplete: false,
		config: Object.freeze({ notifications: config.notifications }),
	};
}

function roster(members: readonly PresenceMember[], state: PresenceState): PresenceEffect {
	return {
		type: "roster",
		members: members
			.filter((member) => member.identity in state.members)
			.map((member) => ({ ...member, status: state.members[member.identity]! })),
	};
}

function transitionPresence(
	member: PresenceMember,
	current: PresenceStatus,
	online: boolean,
	failureCount: number,
): { readonly status: PresenceStatus; readonly effect?: PresenceEffect } {
	if (current === "offline")
		return online ? { status: "online", effect: { type: "joined", member } } : { status: current };
	if (online) return { status: "online" };
	if (current === "unknown" || current === "online") return { status: "suspect" };
	if (failureCount >= DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD)
		return { status: "offline", effect: { type: "left", member } };
	return { status: current };
}

function reduceObservation(
	state: PresenceState,
	input: PresenceReducerInput & { readonly event: Extract<PresenceEvent, { readonly type: "observation" }> },
): PresenceReducerResult {
	const observation = input.event;
	const member = input.members.find((candidate) => candidate.identity === observation.memberIdentity);
	if (!member || !(member.identity in state.members)) return { state, effects: [] };
	const current = state.members[member.identity]!;
	const previousFailures = state.failures[member.identity] ?? 0;
	const failureCount = observation.online ? 0 : current === "offline" ? previousFailures : previousFailures + 1;
	const transition = transitionPresence(member, current, observation.online, failureCount);
	if (transition.status === current && failureCount === state.failures[member.identity])
		return { state, effects: [] };
	return {
		state: {
			...state,
			members: { ...state.members, [member.identity]: transition.status },
			failures: { ...state.failures, [member.identity]: failureCount },
		},
		effects: state.initialScanComplete && transition.effect ? [transition.effect] : [],
	};
}

export function reducePresence(state: PresenceState, input: PresenceReducerInput): PresenceReducerResult {
	if (!state.config.notifications) return { state, effects: [] };
	if (input.event.type === "initial-scan-complete") {
		if (state.initialScanComplete) return { state, effects: [] };
		const next = { ...state, initialScanComplete: true };
		return { state: next, effects: [roster(input.members, next)] };
	}
	return reduceObservation(
		state,
		input as PresenceReducerInput & { event: Extract<PresenceEvent, { type: "observation" }> },
	);
}
