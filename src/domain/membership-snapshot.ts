export const MEMBERSHIP_ENTRY_TYPE = "intray-membership";
export const MEMBERSHIP_SNAPSHOT_VERSION = 1 as const;

export interface PersistedMembershipState {
	readonly active: boolean;
	readonly socketPath: string;
	readonly manifestPath?: string;
	/** Versioned attribution fields are absent in legacy membership entries. */
	readonly snapshotVersion?: typeof MEMBERSHIP_SNAPSHOT_VERSION;
	readonly memberName?: string;
	readonly memberRole?: string;
	readonly manifestFingerprint?: string;
}

/** Reads only the active branch; unrelated branches and raw session content are ignored. */
export function getLatestMembershipState(entries: readonly unknown[]): PersistedMembershipState | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (
			entry.type !== "custom" ||
			entry.customType !== MEMBERSHIP_ENTRY_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		)
			continue;
		const data = entry.data as Partial<PersistedMembershipState>;
		if (typeof data.active !== "boolean" || typeof data.socketPath !== "string") continue;
		const snapshotVersion =
			data.snapshotVersion === MEMBERSHIP_SNAPSHOT_VERSION ? MEMBERSHIP_SNAPSHOT_VERSION : undefined;
		const memberName = typeof data.memberName === "string" ? data.memberName : undefined;
		const memberRole = typeof data.memberRole === "string" ? data.memberRole : undefined;
		const manifestFingerprint = typeof data.manifestFingerprint === "string" ? data.manifestFingerprint : undefined;
		return {
			active: data.active,
			socketPath: data.socketPath,
			...(typeof data.manifestPath === "string" ? { manifestPath: data.manifestPath } : {}),
			...(snapshotVersion === undefined
				? {}
				: {
						snapshotVersion,
						...(memberName === undefined ? {} : { memberName }),
						...(memberRole === undefined ? {} : { memberRole }),
						...(manifestFingerprint === undefined ? {} : { manifestFingerprint }),
					}),
		};
	}
	return null;
}
