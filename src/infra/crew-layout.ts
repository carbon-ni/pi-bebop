import * as path from "node:path";
import { DEFAULT_CREW_MANIFEST_FILE } from "../domain/index.ts";

/**
 * Project-local crew layout rules (pi-agnostic).
 *
 * These functions are pure path logic and intentionally import nothing from
 * Pi packages so the standalone CLI bundle can use them. CONFIG_DIR_NAME is
 * Pi's config directory (".pi"); it is stable and duplicated here only to
 * keep this module free of the Pi runtime dependency.
 */

export const CONFIG_DIR_NAME = ".pi";
const BEBOP_DIR_NAME = "bebop";
const COMPATIBILITY_DIR_NAME = "crew";
const CREW_LAYOUTS = [BEBOP_DIR_NAME, COMPATIBILITY_DIR_NAME] as const;

export type CrewSocketSelection = { readonly socketPath: string; readonly manifestPath: string };

/** Resolve only the two supported project-local crew layouts. */
export function selectCrewSocketPath(rawSocketPath: string, cwd: string): CrewSocketSelection | null {
	const value = rawSocketPath.trim();
	if (!value || value === "@") return null;
	const withoutPrefix = value.startsWith("@") ? value.slice(1) : value;
	if (withoutPrefix.split(/[\\/]+/).includes("..")) return null;
	const socketPath = path.resolve(cwd, withoutPrefix);
	const socketsDir = path.dirname(socketPath);
	const layoutDir = path.dirname(socketsDir);
	if (path.basename(socketsDir) !== "sockets") return null;
	if (!CREW_LAYOUTS.includes(path.basename(layoutDir) as (typeof CREW_LAYOUTS)[number])) return null;
	const piDir = path.dirname(layoutDir);
	if (path.basename(piDir) !== CONFIG_DIR_NAME) return null;
	return { socketPath, manifestPath: path.join(layoutDir, DEFAULT_CREW_MANIFEST_FILE) };
}

export function getDefaultCrewManifestPath(projectRoot: string): string {
	return path.resolve(projectRoot, CONFIG_DIR_NAME, BEBOP_DIR_NAME, DEFAULT_CREW_MANIFEST_FILE);
}

export function getCrewManifestPathFromSocketPath(socketPath: string): string {
	const normalized = path.resolve(socketPath);
	const socketsDir = path.dirname(normalized);
	const layoutDir = path.dirname(socketsDir);
	if (
		path.basename(socketsDir) === "sockets" &&
		CREW_LAYOUTS.includes(path.basename(layoutDir) as (typeof CREW_LAYOUTS)[number])
	) {
		return path.join(layoutDir, DEFAULT_CREW_MANIFEST_FILE);
	}
	return path.resolve(socketsDir, "..", DEFAULT_CREW_MANIFEST_FILE);
}

export function getTrustedCrewManifestPaths(projectRoot: string): string[] {
	const root = path.resolve(projectRoot, CONFIG_DIR_NAME);
	return CREW_LAYOUTS.map((layout) => path.join(root, layout, DEFAULT_CREW_MANIFEST_FILE));
}

export function isTrustedCrewManifestPath(manifestPath: string, projectRoot: string): boolean {
	if (!manifestPath || !projectRoot || manifestPath.includes("\0") || projectRoot.includes("\0")) return false;
	return getTrustedCrewManifestPaths(projectRoot).includes(path.resolve(manifestPath));
}
