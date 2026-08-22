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
	const statuses: Record<string, PresenceStatus> = {};
	const failures: Record<string, number> = {};
	for (const member of members) {
		if (member.name === currentMemberName) continue;
		statuses[member.name] = "unknown";
		failures[member.name] = 0;
	}
	return { members: statuses, failures, initialScanComplete: false, config };
}

function roster(members: readonly PresenceMember[], state: PresenceState): PresenceEffect {
	return {
		type: "roster",
		members: members
			.filter((member) => member.name in state.members)
			.map((member) => ({ ...member, status: state.members[member.name]! })),
	};
}

export function reducePresence(state: PresenceState, input: PresenceReducerInput): PresenceReducerResult {
	if (!state.config.notifications) return { state, effects: [] };
	if (input.event.type === "initial-scan-complete") {
		if (state.initialScanComplete) return { state, effects: [] };
		const next = { ...state, initialScanComplete: true };
		return { state: next, effects: [roster(input.members, next)] };
	}
	const observation = input.event;
	const member = input.members.find((candidate) => candidate.name === observation.memberName);
	if (!member || !(member.name in state.members)) return { state, effects: [] };
	const current = state.members[member.name]!;
	const online = observation.online;
	const failures = { ...state.failures };
	const statuses = { ...state.members };
	let nextStatus = current;
	let effect: PresenceEffect | undefined;
	if (online) {
		failures[member.name] = 0;
		if (current === "offline") {
			nextStatus = "online";
			effect = { type: "joined", member };
		} else if (current === "unknown" || current === "suspect") nextStatus = "online";
	} else {
		failures[member.name] = (failures[member.name] ?? 0) + 1;
		if (current === "online") nextStatus = "suspect";
		else if (current === "suspect" && failures[member.name] >= DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD) {
			nextStatus = "offline";
			effect = { type: "left", member };
		}
	}
	if (nextStatus === current && failures[member.name] === state.failures[member.name]) return { state, effects: [] };
	statuses[member.name] = nextStatus;
	return { state: { ...state, members: statuses, failures }, effects: effect ? [effect] : [] };
}
