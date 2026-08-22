import { isSafeAlias } from "./session-id.ts";

export function createBranchAlias(branchName: string): string | null {
	const slug = toAliasSlug(branchName);
	if (!slug) return null;
	const alias = `branch-${slug}`;
	return isSafeAlias(alias) ? alias : null;
}

export function createSequentialBranchAlias(
	branchName: string,
	usedAliases: string[],
	currentAlias?: string,
): string | null {
	const baseAlias = createBranchAlias(branchName);
	return createSequentialAlias(baseAlias, usedAliases, currentAlias);
}

export function createProjectBranchAlias(projectName: string, branchName: string): string | null {
	const projectSlug = toAliasSlug(projectName);
	const branchSlug = toAliasSlug(branchName);
	if (!projectSlug || !branchSlug) return null;
	const alias = `intra-${projectSlug}-branch-${branchSlug}`;
	return isSafeAlias(alias) ? alias : null;
}

export function createSequentialProjectBranchAlias(
	projectName: string,
	branchName: string,
	usedAliases: string[],
	currentAlias?: string,
): string | null {
	const baseAlias = createProjectBranchAlias(projectName, branchName);
	return createSequentialAlias(baseAlias, usedAliases, currentAlias);
}

function toAliasSlug(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function createSequentialAlias(baseAlias: string | null, usedAliases: string[], currentAlias?: string): string | null {
	if (!baseAlias) return null;
	if (currentAlias?.startsWith(`${baseAlias}-`)) return currentAlias;

	const used = new Set(usedAliases);
	for (let index = 1; ; index++) {
		const alias = `${baseAlias}-${index}`;
		if (!used.has(alias)) return alias;
	}
}
