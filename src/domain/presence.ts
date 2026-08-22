export const DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD = 2;

export type PresenceStatus = "unknown" | "online" | "suspect" | "offline";
export type PresenceMember = { readonly name: string; readonly role: string };
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
	| { readonly type: "observation"; readonly memberName: string; readonly online: boolean }
	| { readonly type: "initial-scan-complete" };
export type PresenceReducerInput = {
	readonly members: readonly PresenceMember[];
	readonly currentMemberName?: string;
	readonly event: PresenceEvent;
};
export type PresenceReducerResult = { readonly state: PresenceState; readonly effects: readonly PresenceEffect[] };

const DEFAULT_CONFIG: PresenceConfig = Object.freeze({ notifications: true });

export function createInitialPresenceState(
	members: readonly PresenceMember[],
	currentMemberName?: string,
	config: PresenceConfig = DEFAULT_CONFIG,
): PresenceState {
	const included = members.filter((member) => member.name !== currentMemberName);
	return {
		members: Object.fromEntries(included.map((member) => [member.name, "unknown" as const])),
		failures: Object.fromEntries(included.map((member) => [member.name, 0])),
		initialScanComplete: false,
		config: Object.freeze({ notifications: config.notifications }),
	};
}

function roster(members: readonly PresenceMember[], state: PresenceState): PresenceEffect {
	return {
		type: "roster",
		members: members
			.filter((member) => member.name in state.members)
			.map((member) => ({ ...member, status: state.members[member.name]! })),
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
	if (failureCount >= DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD) {
		return { status: "offline", effect: { type: "left", member } };
	}
	return { status: current };
}

function reduceObservation(
	state: PresenceState,
	input: PresenceReducerInput & { readonly event: Extract<PresenceEvent, { readonly type: "observation" }> },
): PresenceReducerResult {
	const observation = input.event;
	const member = input.members.find((candidate) => candidate.name === observation.memberName);
	if (!member || !(member.name in state.members)) return { state, effects: [] };
	const current = state.members[member.name]!;
	const previousFailures = state.failures[member.name] ?? 0;
	const failureCount = observation.online ? 0 : current === "offline" ? previousFailures : previousFailures + 1;
	const transition = transitionPresence(member, current, observation.online, failureCount);
	if (transition.status === current && failureCount === state.failures[member.name]) return { state, effects: [] };
	return {
		state: {
			...state,
			members: { ...state.members, [member.name]: transition.status },
			failures: { ...state.failures, [member.name]: failureCount },
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
	return reduceObservation(state, {
		...input,
		event: input.event as Extract<PresenceEvent, { readonly type: "observation" }>,
	});
}
