import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CREW_MANIFEST_FILE,
	parseCrewManifest,
	type CrewManifest,
} from "../domain/index.ts";

const INTRAY_DIR_NAME = "intray";

export type CrewManifestReadErrorCode = "untrusted-project" | "untrusted-path" | "read-failed" | "invalid-json";

export class CrewManifestReadError extends Error {
	readonly code: CrewManifestReadErrorCode;

	constructor(code: CrewManifestReadErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CrewManifestReadError";
		this.code = code;
	}
}

export function getDefaultCrewManifestPath(projectRoot: string): string {
	return path.resolve(projectRoot, CONFIG_DIR_NAME, INTRAY_DIR_NAME, DEFAULT_CREW_MANIFEST_FILE);
}

export function getCrewManifestPathFromSocketPath(socketPath: string): string {
	return path.resolve(path.dirname(socketPath), "..", DEFAULT_CREW_MANIFEST_FILE);
}

export function isTrustedCrewManifestPath(manifestPath: string, projectRoot: string): boolean {
	if (!manifestPath || !projectRoot || manifestPath.includes("\0") || projectRoot.includes("\0")) return false;
	return path.resolve(manifestPath) === getDefaultCrewManifestPath(projectRoot);
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
	if (!trusted) {
		throw new CrewManifestReadError("untrusted-project", "cannot read crew manifest from an untrusted project");
	}

	const normalizedPath = path.resolve(manifestPath);
	if (!isTrustedCrewManifestPath(normalizedPath, projectRoot)) {
		throw new CrewManifestReadError("untrusted-path", `crew manifest is not trusted project-local configuration: ${manifestPath}`);
	}

	let contents: string;
	try {
		contents = await readFile(normalizedPath, "utf8");
	} catch (error) {
		throw new CrewManifestReadError("read-failed", `failed to read crew manifest: ${normalizedPath}`, { cause: error });
	}

	let input: unknown;
	try {
		input = JSON.parse(contents);
	} catch (error) {
		throw new CrewManifestReadError("invalid-json", `invalid JSON in crew manifest: ${normalizedPath}`, { cause: error });
	}
	return parseCrewManifest(input, normalizedPath);
}
