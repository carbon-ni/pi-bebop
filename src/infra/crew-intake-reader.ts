import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseCrewManifest, type CrewManifest } from "../domain/index.ts";
import { CrewManifestReadError } from "./crew-manifest-store.ts";
import { isTrustedCrewManifestPath } from "./crew-layout.ts";

async function realpathOr(filePath: string, io: ManifestIo): Promise<string> {
	if (io.realpath === undefined) return filePath;
	try {
		return await io.realpath(filePath);
	} catch (error) {
		throw new CrewManifestReadError("read-failed", `failed to read crew manifest: ${filePath}`, { cause: error });
	}
}

/**
 * TASK-0136: caller-consent manifest reader for agent-driven intake surfaces
 * (send_to_crew). Mirrors the standalone CLI boundary: the explicit absolute
 * target path plus readable exact-layout manifest plus filesystem permissions
 * are the consent. Enforces the exact supported layout (.pi/bebop or .pi/crew)
 * and never reports the project as Pi-trusted; the trusted inbox store
 * re-validates the exact layout on open. Loads manifest structure only — no
 * instruction files, no sockets, no runtime probing.
 */

export interface ManifestIo {
	readonly readFile: (filePath: string, encoding: "utf8") => Promise<string>;
	readonly realpath?: (filePath: string) => Promise<string>;
}

export const defaultManifestIo: ManifestIo = {
	readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
	realpath: (filePath) => fs.realpath(filePath),
};

export function createCallerConsentManifestLoader(
	io: ManifestIo = defaultManifestIo,
): (manifestPath: string) => Promise<CrewManifest> {
	return async (manifestPath) => {
		const resolved = path.resolve(manifestPath);
		const projectRoot = path.resolve(path.dirname(resolved), "..", "..");
		if (!isTrustedCrewManifestPath(resolved, projectRoot)) {
			throw new CrewManifestReadError(
				"untrusted-path",
				`crew manifest must be in an exact supported layout (.pi/bebop or .pi/crew): ${manifestPath}`,
			);
		}
		// TASK-0136 P1: realpath containment — the manifest reached through the
		// consented lexical layout must still be an exact layout of the SAME real
		// project. A layout directory symlinked into a foreign project (or any
		// traversal escape) is rejected before the manifest is read.
		const realPath = await realpathOr(resolved, io);
		const realProjectRoot = await realpathOr(projectRoot, io);
		if (!isTrustedCrewManifestPath(realPath, realProjectRoot)) {
			throw new CrewManifestReadError(
				"untrusted-path",
				`crew manifest layout escapes its project through a symlink: ${manifestPath}`,
			);
		}
		let contents: string;
		try {
			contents = await io.readFile(realPath, "utf8");
		} catch (error) {
			throw new CrewManifestReadError("read-failed", `failed to read crew manifest: ${resolved}`, {
				cause: error,
			});
		}
		let input: unknown;
		try {
			input = JSON.parse(contents);
		} catch (error) {
			throw new CrewManifestReadError("invalid-json", `invalid JSON in crew manifest: ${resolved}`, {
				cause: error,
			});
		}
		return parseCrewManifest(input, resolved);
	};
}
