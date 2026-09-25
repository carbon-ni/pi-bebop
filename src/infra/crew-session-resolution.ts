import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
	CrewSessionResolutionDependencies,
	CrewSessionResolutionEvidence,
} from "../application/crew-session-resolution.ts";
import { readTrustedCrewManifestMetadata } from "./crew-manifest-store.ts";
import { isTrustedCrewManifestPath } from "./crew-layout.ts";
import { createCrewSessionStore, manifestFingerprint } from "./crew-session-store.ts";
import { probeMemberEndpoint } from "./member-endpoint.ts";
import { resolveMemberEndpoint } from "./socket-endpoint.ts";
import { validateSessionFileEvidence } from "./session-file-security.ts";

async function readSupportedSessionEvidence(file: string, root: string): Promise<CrewSessionResolutionEvidence> {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const manager = SessionManager.open(file, root);
	const header = manager.getHeader();
	if (!header) throw new Error("session file has no supported header");
	return {
		id: header.id,
		root: manager.getSessionDir(),
		membership: manager.getBranch(),
	};
}

async function readSessionFiles(directory: string): Promise<readonly string[]> {
	return (await fs.readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => path.join(directory, entry.name));
}

export function createCrewSessionResolutionDependencies(
	overrides: Partial<CrewSessionResolutionDependencies> = {},
): CrewSessionResolutionDependencies {
	const defaults: CrewSessionResolutionDependencies = {
		store: createCrewSessionStore(),
		isTrustedManifestPath: isTrustedCrewManifestPath,
		manifestFingerprint,
		readManifest: readTrustedCrewManifestMetadata,
		validateSession: validateSessionFileEvidence,
		access: async (target) => fs.access(target),
		resolveEndpoint: resolveMemberEndpoint,
		probe: (endpoint) => probeMemberEndpoint(endpoint),
		readSessionEvidence: readSupportedSessionEvidence,
		readDirectory: readSessionFiles,
	};
	return { ...defaults, ...overrides };
}
