export type SearchableSession = {
	sessionId: string;
	name?: string;
	aliases: string[];
};

export function filterSessionsBySearch<T extends SearchableSession>(sessions: T[], search?: string): T[] {
	const normalizedSearch = search?.trim().toLowerCase();
	if (!normalizedSearch) return sessions;

	return sessions.filter((session) => {
		const values = [session.sessionId, session.name, ...session.aliases];
		return values.some((value) => value?.toLowerCase().includes(normalizedSearch));
	});
}
