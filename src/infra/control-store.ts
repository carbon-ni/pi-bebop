import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { isSafeAlias, isSafeSessionId } from "../domain/session-id.ts";
import { CONTROL_DIR, SOCKET_SUFFIX, getAliasPath } from "./intray-paths.ts";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

export async function ensureControlDir(): Promise<void> {
	await fs.mkdir(CONTROL_DIR, { recursive: true });
}

export async function removeSocket(socketPath: string | null): Promise<void> {
	if (!socketPath) return;
	try {
		await fs.unlink(socketPath);
	} catch (error) {
		if (isErrnoException(error) && error.code !== "ENOENT") throw error;
	}
}

export async function removeAliasesForSocket(socketPath: string | null): Promise<void> {
	if (!socketPath) return;
	try {
		const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isSymbolicLink()) continue;
			const aliasPath = path.join(CONTROL_DIR, entry.name);
			let target: string;
			try { target = await fs.readlink(aliasPath); } catch { continue; }
			const resolvedTarget = path.resolve(CONTROL_DIR, target);
			if (resolvedTarget === socketPath) await fs.unlink(aliasPath);
		}
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return;
		throw error;
	}
}

export async function createAliasSymlink(sessionId: string, alias: string): Promise<void> {
	if (!alias || !isSafeAlias(alias)) return;
	const aliasPath = getAliasPath(alias);
	const target = `${sessionId}${SOCKET_SUFFIX}`;
	try { await fs.unlink(aliasPath); } catch (error) {
		if (isErrnoException(error) && error.code !== "ENOENT") throw error;
	}
	try { await fs.symlink(target, aliasPath); } catch (error) {
		if (isErrnoException(error) && error.code !== "EEXIST") throw error;
	}
}

export async function resolveSessionIdFromAlias(alias: string): Promise<string | null> {
	if (!alias || !isSafeAlias(alias)) return null;
	try {
		const target = await fs.readlink(getAliasPath(alias));
		const base = path.basename(path.resolve(CONTROL_DIR, target));
		if (!base.endsWith(SOCKET_SUFFIX)) return null;
		const sessionId = base.slice(0, -SOCKET_SUFFIX.length);
		return isSafeSessionId(sessionId) ? sessionId : null;
	} catch { return null; }
}

export async function getAliasNames(): Promise<string[]> {
	const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isSymbolicLink() && entry.name.endsWith(".alias"))
		.map((entry) => entry.name.slice(0, -".alias".length));
}

export async function getAliasMap(): Promise<Map<string, string[]>> {
	const aliasMap = new Map<string, string[]>();
	const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isSymbolicLink() || !entry.name.endsWith(".alias")) continue;
		let target: string;
		try { target = await fs.readlink(path.join(CONTROL_DIR, entry.name)); } catch { continue; }
		const resolvedTarget = path.resolve(CONTROL_DIR, target);
		const aliasName = entry.name.slice(0, -".alias".length);
		const aliases = aliasMap.get(resolvedTarget);
		if (aliases) aliases.push(aliasName); else aliasMap.set(resolvedTarget, [aliasName]);
	}
	return aliasMap;
}

export async function isSocketAlive(socketPath: string): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = net.createConnection(socketPath);
		const timeout = setTimeout(() => { socket.destroy(); resolve(false); }, 300);
		const cleanup = (alive: boolean) => { clearTimeout(timeout); socket.removeAllListeners(); resolve(alive); };
		socket.once("connect", () => { socket.end(); cleanup(true); });
		socket.once("error", () => cleanup(false));
	});
}

export type LiveSessionInfo = { sessionId: string; name?: string; aliases: string[]; socketPath: string };

export async function getLiveSessions(): Promise<LiveSessionInfo[]> {
	await ensureControlDir();
	const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
	const aliasMap = await getAliasMap();
	const sessions: LiveSessionInfo[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(SOCKET_SUFFIX)) continue;
		const socketPath = path.join(CONTROL_DIR, entry.name);
		if (!(await isSocketAlive(socketPath))) continue;
		const sessionId = entry.name.slice(0, -SOCKET_SUFFIX.length);
		if (!isSafeSessionId(sessionId)) continue;
		const aliases = aliasMap.get(socketPath) ?? [];
		sessions.push({ sessionId, name: aliases[0], aliases, socketPath });
	}
	sessions.sort((a, b) => (a.name ?? a.sessionId).localeCompare(b.name ?? b.sessionId));
	return sessions;
}
