import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CREW_MANIFEST_FILE, parseCrewManifest, type CrewManifest } from "../domain/index.ts";

const BEBOP_DIR_NAME = "bebop";
const COMPATIBILITY_DIR_NAME = "crew";
const CREW_LAYOUTS = [BEBOP_DIR_NAME, COMPATIBILITY_DIR_NAME] as const;

export type CrewManifestReadErrorCode = "untrusted-project" | "untrusted-path" | "read-failed" | "invalid-json";

export class CrewManifestReadError extends Error {
	readonly code: CrewManifestReadErrorCode;

	constructor(code: CrewManifestReadErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CrewManifestReadError";
		this.code = code;
	}
}

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

type ManifestTrust = () => boolean;
type ReadManifestFile = (filePath: string, encoding: "utf8") => Promise<string>;

export async function readTrustedCrewManifest(
	manifestPath: string,
	projectRoot: string,
	isProjectTrusted: ManifestTrust,
	readFile: ReadManifestFile = (filePath, encoding) => fs.readFile(filePath, encoding),
): Promise<CrewManifest> {
	const trusted = typeof isProjectTrusted === "function" ? isProjectTrusted() : isProjectTrusted;
	if (!trusted)
		throw new CrewManifestReadError("untrusted-project", "cannot read crew manifest from an untrusted project");
	const normalizedPath = path.resolve(manifestPath);
	if (!isTrustedCrewManifestPath(normalizedPath, projectRoot)) {
		throw new CrewManifestReadError(
			"untrusted-path",
			`crew manifest is not trusted project-local configuration: ${manifestPath}`,
		);
	}
	let contents: string;
	try {
		contents = await readFile(normalizedPath, "utf8");
	} catch (error) {
		throw new CrewManifestReadError("read-failed", `failed to read crew manifest: ${normalizedPath}`, {
			cause: error,
		});
	}
	let input: unknown;
	try {
		input = JSON.parse(contents);
	} catch (error) {
		throw new CrewManifestReadError("invalid-json", `invalid JSON in crew manifest: ${normalizedPath}`, {
			cause: error,
		});
	}
	return parseCrewManifest(input, normalizedPath);
}
