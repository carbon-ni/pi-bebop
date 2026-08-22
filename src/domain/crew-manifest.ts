import * as path from "node:path";

export const CREW_MANIFEST_VERSION = 1 as const;
export const DEFAULT_CREW_MANIFEST_FILE = "crew.json";

export interface CrewMember {
	readonly name: string;
	readonly role: string;
	readonly socket: string;
	readonly socketPath: string;
	readonly instructions?: string;
}

export interface CrewManifest {
	readonly version: typeof CREW_MANIFEST_VERSION;
	readonly members: readonly CrewMember[];
}

export type CrewManifestErrorCode =
	| "invalid-manifest"
	| "invalid-version"
	| "invalid-members"
	| "invalid-member"
	| "invalid-socket-path"
	| "duplicate-member-name"
	| "duplicate-socket-path";

export class CrewManifestError extends Error {
	readonly code: CrewManifestErrorCode;

	constructor(code: CrewManifestErrorCode, message: string) {
		super(message);
		this.name = "CrewManifestError";
		this.code = code;
	}
}

export type CrewMemberLookup =
	| { readonly kind: "match"; readonly member: CrewMember }
	| { readonly kind: "no-match"; readonly socketPath: string }
	| { readonly kind: "duplicate-path"; readonly socketPath: string; readonly members: readonly CrewMember[] };

export class CrewMemberLookupError extends Error {
	readonly code: "no-match" | "duplicate-path";
	readonly socketPath: string;

	constructor(code: "no-match" | "duplicate-path", socketPath: string) {
		super(code === "no-match" ? `no crew member matches socket path: ${socketPath}` : `duplicate crew members match socket path: ${socketPath}`);
		this.name = "CrewMemberLookupError";
		this.code = code;
		this.socketPath = socketPath;
	}
}

function invalid(message: string, code: CrewManifestErrorCode = "invalid-manifest"): never {
	throw new CrewManifestError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		invalid(`${field} must be a non-empty string`, "invalid-member");
	}
	return value;
}

export function resolveCrewMemberSocketPath(member: Pick<CrewMember, "socket">, manifestPath: string): string {
	if (typeof manifestPath !== "string" || manifestPath.trim().length === 0 || manifestPath.includes("\0")) {
		invalid("manifest path must be a non-empty path");
	}
	if (path.isAbsolute(member.socket)) {
		invalid("member socket path must be relative to the crew manifest", "invalid-socket-path");
	}
	const socketsRoot = path.resolve(path.dirname(manifestPath), "sockets");
	const socketPath = path.resolve(path.dirname(manifestPath), member.socket);
	const relativePath = path.relative(socketsRoot, socketPath);
	if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
		invalid("member socket path must remain under the crew sockets directory", "invalid-socket-path");
	}
	return socketPath;
}

export function parseCrewManifest(input: unknown, manifestPath = DEFAULT_CREW_MANIFEST_FILE): CrewManifest {
	if (!isRecord(input)) invalid("manifest must be an object");
	if (input.version !== CREW_MANIFEST_VERSION) {
		throw new CrewManifestError("invalid-version", `unsupported manifest version: ${String(input.version)}`);
	}
	if (!Array.isArray(input.members) || input.members.length === 0) {
		throw new CrewManifestError("invalid-members", "members must be a non-empty array");
	}

	const names = new Set<string>();
	const socketPaths = new Map<string, CrewMember[]>();
	const members: CrewMember[] = [];
	for (const [index, rawMember] of input.members.entries()) {
		if (!isRecord(rawMember)) invalid(`members[${index}] must be an object`, "invalid-member");
		const name = requireText(rawMember.name, `members[${index}].name`);
		const role = requireText(rawMember.role, `members[${index}].role`);
		const socket = requireText(rawMember.socket, `members[${index}].socket`);
		const instructions = rawMember.instructions;
		if (instructions !== undefined && typeof instructions !== "string") {
			invalid(`members[${index}].instructions must be a string`, "invalid-member");
		}
		const validInstructions = typeof instructions === "string" ? instructions : undefined;
		if (names.has(name)) {
			throw new CrewManifestError("duplicate-member-name", `duplicate member name: ${name}`);
		}
		names.add(name);
		const member: CrewMember = {
			name,
			role,
			socket,
			socketPath: resolveCrewMemberSocketPath({ socket }, manifestPath),
			...(validInstructions === undefined ? {} : { instructions: validInstructions }),
		};
		const samePath = socketPaths.get(member.socketPath) ?? [];
		samePath.push(member);
		socketPaths.set(member.socketPath, samePath);
		members.push(member);
	}

	for (const [socketPath, matchingMembers] of socketPaths) {
		if (matchingMembers.length > 1) {
			throw new CrewManifestError("duplicate-socket-path", `duplicate socket path: ${socketPath}`);
		}
	}
	return { version: CREW_MANIFEST_VERSION, members };
}

export function lookupCrewMemberBySocketPath(manifest: CrewManifest, socketPath: string): CrewMemberLookup {
	const normalizedPath = path.resolve(socketPath);
	const matches = manifest.members.filter((member) => member.socketPath === normalizedPath);
	if (matches.length === 0) return { kind: "no-match", socketPath: normalizedPath };
	if (matches.length > 1) return { kind: "duplicate-path", socketPath: normalizedPath, members: matches };
	return { kind: "match", member: matches[0] };
}

export function resolveCrewMemberBySocketPath(manifest: CrewManifest, socketPath: string): CrewMember {
	const result = lookupCrewMemberBySocketPath(manifest, socketPath);
	if (result.kind === "no-match") throw new CrewMemberLookupError("no-match", result.socketPath);
	if (result.kind === "duplicate-path") throw new CrewMemberLookupError("duplicate-path", result.socketPath);
	return result.member;
}
