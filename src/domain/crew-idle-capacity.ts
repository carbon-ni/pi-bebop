export type CrewIdleCapacityOwner = "crew-member-idle-command" | "crew-idle-tool" | "member-idle-tool";

export interface CrewIdleCapacityLease {
	/** Opaque identity for this lease. It must never be reused by a later owner. */
	readonly token: symbol;
	readonly owner: CrewIdleCapacityOwner;
	/** Releases this lease once. A stale lease cannot release a newer owner. */
	readonly release: () => boolean;
}

export interface CrewIdleCapacity {
	readonly acquire: (owner: CrewIdleCapacityOwner) => CrewIdleCapacityLease | null;
}

/** Session-local private capacity shared by every Crew idle wait surface. */
export function createCrewIdleCapacity(): CrewIdleCapacity {
	let active: { readonly token: symbol; readonly owner: CrewIdleCapacityOwner } | undefined;
	return {
		acquire: (owner) => {
			if (active) return null;
			const token = Symbol("crew-idle-capacity");
			active = { token, owner };
			let released = false;
			return {
				token,
				owner,
				release: () => {
					if (released || active?.token !== token || active.owner !== owner) return false;
					released = true;
					active = undefined;
					return true;
				},
			};
		},
	};
}
