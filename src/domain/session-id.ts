export function isSafeSessionId(sessionId: string): boolean {
	return !sessionId.includes("/") && !sessionId.includes("\\") && !sessionId.includes("..") && sessionId.length > 0;
}

export function isSafeAlias(alias: string): boolean {
	return !alias.includes("/") && !alias.includes("\\") && !alias.includes("..") && alias.length > 0;
}
