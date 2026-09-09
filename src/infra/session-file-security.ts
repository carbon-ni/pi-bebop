import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export type SessionFileValidationCode =
	| "missing-session-file"
	| "malformed-session"
	| "untrusted-session-root"
	| "session-id-mismatch"
	| "session-cwd-mismatch";

export class SessionFileValidationError extends Error {
	readonly code: SessionFileValidationCode;
	constructor(code: SessionFileValidationCode, message: string) {
		super(message);
		this.name = "SessionFileValidationError";
		this.code = code;
	}
}

function uid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isDescendantOrSame(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return (
		relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

async function inspectPrivatePath(
	target: string,
	directory: boolean,
	privateBoundary?: string,
): Promise<{ uid?: number; mode: number }> {
	const absolute = path.resolve(target);
	const boundary = privateBoundary === undefined ? undefined : path.resolve(privateBoundary);
	if (boundary !== undefined && !isDescendantOrSame(boundary, absolute))
		throw new SessionFileValidationError("untrusted-session-root", "session path escapes its reported root");
	const parsed = path.parse(absolute);
	let current = parsed.root;
	let enforcePrivate = false;
	for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		let stat;
		try {
			stat = await fs.lstat(current);
		} catch {
			throw new SessionFileValidationError("missing-session-file", "session path does not exist");
		}
		if (stat.isSymbolicLink())
			throw new SessionFileValidationError("untrusted-session-root", "session path contains a symlink");
		if (current === boundary || (boundary === undefined && current === absolute)) enforcePrivate = true;
		const owner = uid();
		if (enforcePrivate && (stat.mode & 0o022) !== 0)
			throw new SessionFileValidationError("untrusted-session-root", "session path is group/world-writable");
		if (enforcePrivate && owner !== undefined && stat.uid !== owner)
			throw new SessionFileValidationError("untrusted-session-root", "session path is not current-user owned");
		if (current === absolute) {
			if (directory ? !stat.isDirectory() : !stat.isFile())
				throw new SessionFileValidationError(
					"untrusted-session-root",
					`session path is not a regular ${directory ? "directory" : "file"}`,
				);
			return { uid: stat.uid, mode: stat.mode };
		}
	}
	throw new SessionFileValidationError("untrusted-session-root", "session path is invalid");
}

function isDescendant(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative.length > 0 && isDescendantOrSame(root, file);
}

export interface SessionFileEvidence {
	readonly id: string;
	readonly file: string;
	readonly cwd: string;
	readonly root: string;
}

/** Open a session through Pi's public API without making the CLI bundle depend on Pi at startup. */
async function openSupportedSession(file: string, root: string): Promise<SessionManager> {
	try {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		return SessionManager.open(file, root);
	} catch (error) {
		throw new SessionFileValidationError("malformed-session", "session file is not a supported Pi session");
	}
}

/** Validate path policy and the supported Pi session header without reading conversation content in Bebop. */
export async function validateSessionFileEvidence(evidence: SessionFileEvidence): Promise<void> {
	if (!path.isAbsolute(evidence.file) || !path.isAbsolute(evidence.root) || !path.isAbsolute(evidence.cwd))
		throw new SessionFileValidationError("untrusted-session-root", "session paths must be absolute");
	await inspectPrivatePath(evidence.root, true);
	await inspectPrivatePath(evidence.file, false, evidence.root);
	const canonicalRoot = path.resolve(evidence.root);
	const canonicalFile = path.resolve(evidence.file);
	if (!isDescendant(canonicalRoot, canonicalFile))
		throw new SessionFileValidationError(
			"untrusted-session-root",
			"session file is outside the reported session root",
		);
	const manager = await openSupportedSession(canonicalFile, canonicalRoot);
	const header = manager.getHeader();
	if (!header) throw new SessionFileValidationError("malformed-session", "session file has no supported header");
	if (header.id !== evidence.id)
		throw new SessionFileValidationError("session-id-mismatch", "session header ID differs from active session ID");
	if (path.resolve(header.cwd) !== path.resolve(evidence.cwd))
		throw new SessionFileValidationError(
			"session-cwd-mismatch",
			"session header cwd differs from active session cwd",
		);
}
