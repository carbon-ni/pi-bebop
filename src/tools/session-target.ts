import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getCrewManifestPathFromSocketPath } from "../infra/crew-manifest-store.ts";
import { getSocketPath } from "../infra/intray-paths.ts";
import { resolveCrewMemberBySocketPath, isSafeSessionId, type CrewManifest } from "../domain/index.ts";

export interface SessionTargetInput {
	readonly socketPath?: string;
	readonly sessionId?: string;
	readonly sessionName?: string;
	readonly cwd: string;
	readonly isProjectTrusted: () => boolean;
	readonly currentSessionId?: string;
}

export interface SessionTargetDependencies {
	resolveAlias?: (sessionName: string) => Promise<string | null>;
	loadManifest: (manifestPath: string) => Promise<CrewManifest>;
	readlink?: (socketPath: string) => Promise<string>;
}

export interface SessionTarget {
	readonly socketPath: string;
	readonly sessionId?: string;
	readonly displayTarget: string;
}

export type SessionTargetErrorCode = "missing-target" | "invalid-session-id" | "unknown-session-name" | "untrusted-project" | "unknown-member" | "target-mismatch";

export class SessionTargetError extends Error {
	readonly code: SessionTargetErrorCode;

	constructor(code: SessionTargetErrorCode, message: string) {
		super(message);
		this.name = "SessionTargetError";
		this.code = code;
	}
}

function normalizedSocketPath(socketPath: string, cwd: string): string {
	const trimmed = socketPath.trim();
	const withoutPrefix = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	return path.resolve(cwd, withoutPrefix);
}

function resolvedLinkTarget(socketPath: string, target: string): string {
	return path.resolve(path.dirname(socketPath), target);
}

export async function resolveSessionTarget(input: SessionTargetInput, dependencies: SessionTargetDependencies): Promise<SessionTarget> {
	const sessionId = input.sessionId?.trim();
	const sessionName = input.sessionName?.trim();
	let resolvedNameId: string | null = null;
	if (sessionName) {
		resolvedNameId = await (dependencies.resolveAlias ?? (async () => null))(sessionName);
		if (!resolvedNameId) throw new SessionTargetError("unknown-session-name", "Unknown session name");
	}
	if (sessionId && !isSafeSessionId(sessionId)) throw new SessionTargetError("invalid-session-id", "Invalid session id");
	if (resolvedNameId && sessionId && resolvedNameId !== sessionId) {
		throw new SessionTargetError("target-mismatch", "Session name does not match session id");
	}
	const targetSessionId = sessionId ?? resolvedNameId ?? undefined;
	if (targetSessionId && input.currentSessionId && targetSessionId === input.currentSessionId) {
		throw new SessionTargetError("target-mismatch", "Cannot target the current session");
	}

	if (input.socketPath?.trim()) {
		if (!input.isProjectTrusted()) throw new SessionTargetError("untrusted-project", "Project is not trusted");
		const socketPath = normalizedSocketPath(input.socketPath, input.cwd);
		const manifestPath = getCrewManifestPathFromSocketPath(socketPath);
		let manifest: CrewManifest;
		try {
			manifest = await dependencies.loadManifest(manifestPath);
		} catch (error) {
			throw new SessionTargetError("unknown-member", `Unknown configured crew member for socket path: ${socketPath}`);
		}
		try {
			resolveCrewMemberBySocketPath(manifest, socketPath);
		} catch {
			throw new SessionTargetError("unknown-member", `Unknown configured crew member for socket path: ${socketPath}`);
		}
		if (targetSessionId || input.currentSessionId) {
			try {
				const link = await (dependencies.readlink ?? ((target: string) => fs.readlink(target)))(socketPath);
				const linkedSocket = resolvedLinkTarget(socketPath, link);
				if (input.currentSessionId && linkedSocket === path.resolve(getSocketPath(input.currentSessionId))) {
					throw new SessionTargetError("target-mismatch", "Cannot target the current session");
				}
				if (targetSessionId && linkedSocket !== path.resolve(getSocketPath(targetSessionId))) {
					throw new SessionTargetError("target-mismatch", "Socket path does not match the requested session target");
				}
			} catch (error) {
				if (error instanceof SessionTargetError) throw error;
				if (targetSessionId) throw new SessionTargetError("target-mismatch", "Socket path does not match the requested session target");
			}
		}
		return { socketPath, sessionId: targetSessionId, displayTarget: socketPath };
	}

	if (!targetSessionId) throw new SessionTargetError("missing-target", "Missing socket path, session id, or session name");
	return { socketPath: getSocketPath(targetSessionId), sessionId: targetSessionId, displayTarget: sessionName ?? targetSessionId };
}
