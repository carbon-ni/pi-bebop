export function getSessionEnvValue(enabled: boolean, sessionId?: string): string | undefined {
	if (!enabled) return undefined;
	return sessionId;
}

export function updateProcessSessionEnv(enabled: boolean, sessionId?: string): void {
	const value = getSessionEnvValue(enabled, sessionId);
	if (value) {
		process.env.PI_SESSION_ID = value;
		return;
	}
	delete process.env.PI_SESSION_ID;
}
