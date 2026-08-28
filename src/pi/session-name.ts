import type { Membership } from "../infra/membership-runtime.ts";
import {
	getLatestSessionNameState,
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

function snapshot(membership: Membership): SessionNameMembership {
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

	const persist = () => host.appendEntry(SESSION_NAME_ENTRY_TYPE, sessionNameStateToEntryData(state));
	const apply = (action: ReturnType<typeof reconcileSessionName>["action"]) => {
		if (action.type === "none") return;
		const name = action.type === "set" ? action.name : undefined;
		internalEvents.push(name);
		try {
			host.setSessionName(name ?? "");
		} catch (error) {
			internalEvents.pop();
			throw error;
		}
	};

	return {
		restore(entries) {
			const restored = getLatestSessionNameState(entries);
			if (!restored) {
				state = { ownership: "inactive" };
				return;
			}
			if (restored.ownership === "auto" && host.getSessionName() !== restored.sessionName) {
				state = { ownership: "inactive" };
				return;
			}
			state = restored;
		},
		syncMembership(membership) {
			const next = reconcileSessionName(state, membership ? snapshot(membership) : null, host.getSessionName());
			const changed = !equalState(state, next.state);
			state = next.state;
			apply(next.action);
			if (changed) persist();
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
