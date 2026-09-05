export const BUILD_COMMIT_ENV = "PI_BEBOP_BUILD_COMMIT";
const FULL_COMMIT_SHA = /^[0-9a-fA-F]{40}$/;

/**
 * Validates and canonicalizes the immutable source revision embedded in an
 * artifact. Git currently produces SHA-1 object IDs; accepting only a full
 * 40-character value prevents abbreviated or otherwise ambiguous provenance.
 */
export function normalizeBuildCommit(value) {
	if (typeof value !== "string" || !FULL_COMMIT_SHA.test(value))
		throw new Error("Build commit must be a full 40-character hexadecimal commit SHA");
	return value.toLowerCase();
}

/**
 * Resolves build provenance without performing any IO. The build entrypoint
 * supplies Git's output; an explicit override is intended for release systems
 * that do not retain the source repository metadata.
 */
export function resolveBuildCommit({ gitCommit, override } = {}) {
	if (override !== undefined) return normalizeBuildCommit(override);
	if (gitCommit === undefined)
		throw new Error(`Missing Git metadata; set ${BUILD_COMMIT_ENV} to a full 40-character hexadecimal commit SHA`);
	return normalizeBuildCommit(gitCommit.trim());
}
