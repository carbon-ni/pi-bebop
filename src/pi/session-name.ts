import type { Membership } from "../infra/membership-runtime.ts";
import {
	getLatestSessionNameState,
	isCrewDisplayName,
	observeSessionNameChange,
	reconcileSessionName,
	sessionNameStateToEntryData,
	SESSION_NAME_ENTRY_TYPE,
	type SessionNameMembership,
	type SessionNameState,
} from "../domain/index.ts";

export interface SessionNameHost {
	setSessionName(name: string): void;
	getSessionName(): string | undefined;
	appendEntry(customType: string, data: unknown): void;
}

export interface SessionNameController {
	restore(entries: readonly unknown[]): void;
	syncMembership(membership: Membership | null): void;
	observeChange(name: string | undefined): void;
	isAutoOwned(): boolean;
}

function snapshot(membership: Membership): SessionNameMembership | null {
	if (!isCrewDisplayName(membership.member.name)) return null;
	return {
		manifestPath: membership.manifestPath,
		socketPath: membership.socketPath,
		memberName: membership.member.name,
		memberRole: membership.member.role,
	};
}

function equalState(a: SessionNameState, b: SessionNameState): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function createSessionNameController(host: SessionNameHost): SessionNameController {
	let state: SessionNameState = { ownership: "inactive" };
	const internalEvents: Array<string | undefined> = [];

	const persist = () => {
		try {
			host.appendEntry(SESSION_NAME_ENTRY_TYPE, sessionNameStateToEntryData(state));
		} catch {
			// Session metadata must never make a membership operation fail.
		}
	};
	const currentName = (): string | undefined => {
		try {
			return host.getSessionName();
		} catch {
			return undefined;
		}
	};
	const apply = (action: ReturnType<typeof reconcileSessionName>["action"]): boolean => {
		if (action.type === "none") return true;
		const name = action.type === "set" ? action.name : undefined;
		internalEvents.push(name);
		try {
			host.setSessionName(name ?? "");
			return true;
		} catch {
			internalEvents.pop();
			return false;
		}
	};

	return {
		restore(entries) {
			const restored = getLatestSessionNameState(entries);
			if (!restored) {
				state = { ownership: "inactive" };
				return;
			}
			if (restored.ownership === "auto" && currentName() !== restored.sessionName) {
				state = { ownership: "inactive" };
				return;
			}
			state = restored;
		},
		syncMembership(membership) {
			const previous = state;
			const currentMembership = membership ? snapshot(membership) : null;
			const next = reconcileSessionName(state, currentMembership, currentName());
			if (!apply(next.action)) return;
			state = next.state;
			if (!equalState(previous, state)) persist();
		},
		observeChange(name) {
			if (internalEvents.length > 0 && Object.is(internalEvents[0], name)) {
				internalEvents.shift();
				return;
			}
			const next = observeSessionNameChange(state, name);
			if (equalState(state, next)) return;
			state = next;
			persist();
		},
		isAutoOwned() {
			return state.ownership === "auto";
		},
	};
}
