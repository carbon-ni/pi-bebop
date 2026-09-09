import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface CurrentPiSessionEvidence {
	readonly persisted: boolean;
	readonly id: string;
	readonly file?: string;
	readonly cwd: string;
	readonly root: string;
}

/**
 * Read only public SessionManager metadata. This deliberately does not inspect
 * the JSONL body: the capture contract binds the active session by its public
 * header/lifecycle metadata and leaves conversation content owned by Pi.
 */
export function readCurrentPiSessionEvidence(
	context: Pick<ExtensionContext, "sessionManager">,
): CurrentPiSessionEvidence {
	const manager = context.sessionManager;
	const id = manager.getSessionId();
	const cwd = manager.getCwd();
	const root = manager.getSessionDir();
	const file = manager.getSessionFile();
	const persisted = file !== undefined;
	if (typeof id !== "string" || id.length === 0) throw new Error("session manager returned an empty session ID");
	if (typeof cwd !== "string" || cwd.length === 0) throw new Error("session manager returned an empty session cwd");
	if (typeof root !== "string" || root.length === 0)
		throw new Error("session manager returned an empty session root");
	if (persisted && (typeof file !== "string" || file.length === 0))
		throw new Error("persisted session manager returned no session file");
	return { persisted, id, ...(file === undefined ? {} : { file }), cwd, root };
}
