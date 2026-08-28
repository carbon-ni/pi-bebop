export const SESSION_NAME_ENTRY_TYPE = "intray-session-name";
export const MAX_SESSION_NAME_STATE_BYTES = 4096;
const MAX_SESSION_NAME_TEXT_BYTES = 256;

export interface SessionNameMembership {
	readonly manifestPath: string;
	readonly socketPath: string;
	readonly memberName: string;
	readonly memberRole: string;
}

export type SessionNameState =
	| { readonly ownership: "inactive" }
	| { readonly ownership: "auto"; readonly sessionName: string; readonly membership: SessionNameMembership }
	| {
			readonly ownership: "user";
			readonly sessionName?: string;
			readonly membership?: SessionNameMembership;
	  };

export type SessionNameAction =
	| { readonly type: "none" }
	| { readonly type: "set"; readonly name: string }
	| { readonly type: "clear" };

export interface SessionNameReconciliation {
	readonly state: SessionNameState;
	readonly action: SessionNameAction;
}

function boundedText(value: unknown, maxBytes = MAX_SESSION_NAME_TEXT_BYTES): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!/[\u0000-\u001f\u007f]/u.test(value) &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

function validMembership(value: unknown): value is SessionNameMembership {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SessionNameMembership>;
	const keys = Object.keys(candidate);
	return (
		keys.every((key) => ["manifestPath", "socketPath", "memberName", "memberRole"].includes(key)) &&
		keys.length === 4 &&
		boundedText(candidate.manifestPath) &&
		boundedText(candidate.socketPath) &&
		boundedText(candidate.memberName) &&
		boundedText(candidate.memberRole)
	);
}

function sameMember(a: SessionNameMembership, b: SessionNameMembership): boolean {
	return a.manifestPath === b.manifestPath && a.socketPath === b.socketPath && a.memberName === b.memberName;
}

function userState(currentName: string | undefined, membership: SessionNameMembership): SessionNameState {
	const retainedName = currentName !== undefined && boundedText(currentName) ? currentName : undefined;
	return { ownership: "user", ...(retainedName === undefined ? {} : { sessionName: retainedName }), membership };
}

export function reconcileSessionName(
	previous: SessionNameState,
	membership: SessionNameMembership | null,
	currentName: string | undefined,
): SessionNameReconciliation {
	if (!membership) {
		if (previous.ownership === "auto" && currentName === previous.sessionName)
			return { state: { ownership: "inactive" }, action: { type: "clear" } };
		if (previous.ownership === "auto") {
			return {
				state: userState(currentName, previous.membership),
				action: { type: "none" },
			};
		}
		return { state: previous, action: { type: "none" } };
	}

	if (previous.ownership === "user") return { state: previous, action: { type: "none" } };

	if (previous.ownership === "auto" && sameMember(previous.membership, membership)) {
		if (currentName === previous.sessionName)
			return {
				state: { ownership: "auto", sessionName: previous.sessionName, membership },
				action: { type: "none" },
			};
		if (currentName !== undefined) return { state: userState(currentName, membership), action: { type: "none" } };
	}

	if (currentName !== undefined && (previous.ownership !== "auto" || currentName !== previous.sessionName)) {
		return { state: userState(currentName, membership), action: { type: "none" } };
	}

	return {
		state: { ownership: "auto", sessionName: membership.memberName, membership },
		action: currentName === membership.memberName ? { type: "none" } : { type: "set", name: membership.memberName },
	};
}

/** Apply an observed external/manual session metadata change. */
export function observeSessionNameChange(
	previous: SessionNameState,
	currentName: string | undefined,
): SessionNameState {
	if (previous.ownership === "inactive") return previous;
	const retainedName = currentName !== undefined && boundedText(currentName) ? currentName : undefined;
	return {
		ownership: "user",
		...(retainedName === undefined ? {} : { sessionName: retainedName }),
		...(previous.membership === undefined ? {} : { membership: previous.membership }),
	};
}

export function sessionNameStateToEntryData(state: SessionNameState): Record<string, unknown> {
	return { version: 1, ...state };
}

function hasOnlyStateKeys(candidate: Record<string, unknown>, ownership: string): boolean {
	const allowedKeys =
		ownership === "inactive" ? ["version", "ownership"] : ["version", "ownership", "sessionName", "membership"];
	return Object.keys(candidate).every((key) => allowedKeys.includes(key));
}

function parseAutoState(candidate: Record<string, unknown>): SessionNameState | null {
	if (!boundedText(candidate.sessionName) || !validMembership(candidate.membership)) return null;
	return { ownership: "auto", sessionName: candidate.sessionName, membership: candidate.membership };
}

function parseUserState(candidate: Record<string, unknown>): SessionNameState | null {
	if (candidate.sessionName !== undefined && !boundedText(candidate.sessionName)) return null;
	if (candidate.membership !== undefined && !validMembership(candidate.membership)) return null;
	return {
		ownership: "user",
		...(candidate.sessionName === undefined ? {} : { sessionName: candidate.sessionName as string }),
		...(candidate.membership === undefined ? {} : { membership: candidate.membership as SessionNameMembership }),
	};
}

function parseState(value: unknown): SessionNameState | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (
		candidate.version !== 1 ||
		(candidate.ownership !== "inactive" && candidate.ownership !== "auto" && candidate.ownership !== "user") ||
		!hasOnlyStateKeys(candidate, candidate.ownership)
	)
		return null;
	if (candidate.ownership === "inactive") return { ownership: "inactive" };
	return candidate.ownership === "auto" ? parseAutoState(candidate) : parseUserState(candidate);
}

export function getLatestSessionNameState(entries: readonly unknown[]): SessionNameState | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== SESSION_NAME_ENTRY_TYPE) continue;
		let serialized: string;
		try {
			serialized = JSON.stringify(entry.data ?? null);
		} catch {
			return null;
		}
		if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_NAME_STATE_BYTES) return null;
		return parseState(entry.data);
	}
	return null;
}
