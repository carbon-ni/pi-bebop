export interface CrewIdleCapacityLease {
	readonly release: () => void;
}

export interface CrewIdleCapacity {
	readonly acquire: () => CrewIdleCapacityLease | null;
}

/** Session-local private capacity shared by every Crew idle wait surface. */
export function createCrewIdleCapacity(): CrewIdleCapacity {
	let occupied = false;
	return {
		acquire: () => {
			if (occupied) return null;
			occupied = true;
			let released = false;
			return {
				release: () => {
					if (released) return;
					released = true;
					occupied = false;
				},
			};
		},
	};
}
