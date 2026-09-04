import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAliasSymlink, getAliasNames, removeAliasesForSocket } from "../../infra/control-store.ts";
import { getCurrentGitBranch, getGitProjectName } from "../../infra/git-branch.ts";
import { createProjectBranchAlias, createSequentialProjectBranchAlias, isSafeAlias } from "../../domain/index.ts";
import type { SocketState } from "./types.ts";
import { isStaleContextError } from "./utils.ts";

export function getSessionAlias(ctx: ExtensionContext): string | null {
	const sessionName = ctx.sessionManager.getSessionName();
	const alias = sessionName ? sessionName.trim() : "";
	if (!alias || !isSafeAlias(alias)) return null;
	return alias;
}

export async function getBranchAlias(currentAliases: string[]): Promise<string | null> {
	const [branch, project] = await Promise.all([getCurrentGitBranch(), getGitProjectName()]);
	const baseAlias = branch && project ? createProjectBranchAlias(project, branch) : null;
	if (!branch || !project || !baseAlias) return null;
	const currentAlias = currentAliases.find((alias) => alias.startsWith(`${baseAlias}-`));
	return createSequentialProjectBranchAlias(project, branch, await getAliasNames(), currentAlias);
}

export async function getSessionAliases(ctx: ExtensionContext, currentAliases: string[]): Promise<string[]> {
	const aliases = [getSessionAlias(ctx), await getBranchAlias(currentAliases)].filter((alias): alias is string =>
		Boolean(alias),
	);
	return Array.from(new Set(aliases));
}

export async function syncAlias(state: SocketState, ctx: ExtensionContext): Promise<void> {
	if (!state.server || !state.socketPath) return;

	try {
		const aliases = await getSessionAliases(ctx, state.aliases);
		if (aliases.length === state.aliases.length && aliases.every((alias, index) => alias === state.aliases[index]))
			return;

		const sessionId = ctx.sessionManager.getSessionId();
		await removeAliasesForSocket(state.socketPath);
		for (const alias of aliases) await createAliasSymlink(sessionId, alias);
		state.aliases = aliases;
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
		if (state.context === ctx) state.context = null;
	}
}
