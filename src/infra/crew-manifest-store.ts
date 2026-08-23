import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CREW_MANIFEST_FILE, parseCrewManifest, type CrewManifest } from "../domain/index.ts";

const BEBOP_DIR_NAME = "bebop";
const COMPATIBILITY_DIR_NAME = "crew";
const CREW_LAYOUTS = [BEBOP_DIR_NAME, COMPATIBILITY_DIR_NAME] as const;

export const MAX_CREW_INSTRUCTIONS_FILE_BYTES = 64 * 1024;
export type CrewManifestReadErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "read-failed"
	| "invalid-json"
	| "instructions-directory-failed"
	| "instructions-file-missing"
	| "instructions-file-unreadable"
	| "instructions-file-directory"
	| "instructions-file-unsafe"
	| "instructions-file-invalid-encoding"
	| "instructions-file-empty"
	| "instructions-file-nul"
	| "instructions-file-oversized"
	| "instructions-file-changed";

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
type ReadInstructionFile = (filePath: string, maxBytes: number) => Promise<Buffer>;

async function readInstructionFileBounded(filePath: string, maxBytes: number): Promise<Buffer> {
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const result = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		return buffer.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

export async function readTrustedCrewManifest(
	manifestPath: string,
	projectRoot: string,
	isProjectTrusted: ManifestTrust,
	readFile: ReadManifestFile = (filePath, encoding) => fs.readFile(filePath, encoding),
	readInstructionFile: ReadInstructionFile = readInstructionFileBounded,
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
	const manifest = parseCrewManifest(input, normalizedPath);
	if (!manifest.members.some((member) => member.instructionsFile !== undefined)) return manifest;
	const crewRoot = path.dirname(normalizedPath);
	let realCrewRoot: string;
	let realInstructionsRoot: string;
	try {
		realCrewRoot = await fs.realpath(crewRoot);
		realInstructionsRoot = await fs.realpath(path.join(crewRoot, "instructions"));
	} catch (error) {
		throw new CrewManifestReadError(
			"instructions-directory-failed",
			"failed to resolve the member instructions directory",
			{ cause: error },
		);
	}
	const rootRelative = path.relative(realCrewRoot, realInstructionsRoot);
	if (
		!rootRelative ||
		rootRelative === ".." ||
		rootRelative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(rootRelative)
	) {
		throw new CrewManifestReadError(
			"instructions-file-unsafe",
			"crew instructions directory is outside the trusted crew directory",
		);
	}
	const members = [] as CrewManifest["members"] extends readonly (infer T)[] ? T[] : never;
	for (const member of manifest.members) {
		if (member.instructionsFile === undefined) {
			members.push(member);
			continue;
		}
		const requested = path.resolve(crewRoot, member.instructionsFile);
		let realFile: string;
		try {
			realFile = await fs.realpath(requested);
		} catch (error) {
			const code =
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "instructions-file-missing"
					: "instructions-file-unreadable";
			throw new CrewManifestReadError(code, `members.${member.name}.instructionsFile could not be resolved`, {
				cause: error,
			});
		}
		const relative = path.relative(realInstructionsRoot, realFile);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new CrewManifestReadError(
				"instructions-file-unsafe",
				`members.${member.name}.instructionsFile is outside instructions/`,
			);
		}
		let before: Awaited<ReturnType<typeof fs.stat>>;
		try {
			before = await fs.stat(realFile);
		} catch (error) {
			const code =
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "instructions-file-missing"
					: "instructions-file-unreadable";
			throw new CrewManifestReadError(code, `members.${member.name}.instructionsFile could not be read`, {
				cause: error,
			});
		}
		if (before.isDirectory())
			throw new CrewManifestReadError(
				"instructions-file-directory",
				`members.${member.name}.instructionsFile is a directory`,
			);
		if (!before.isFile())
			throw new CrewManifestReadError(
				"instructions-file-unreadable",
				`members.${member.name}.instructionsFile is not a regular file`,
			);
		if (before.size > MAX_CREW_INSTRUCTIONS_FILE_BYTES)
			throw new CrewManifestReadError(
				"instructions-file-oversized",
				`members.${member.name}.instructionsFile exceeds ${MAX_CREW_INSTRUCTIONS_FILE_BYTES} bytes`,
			);
		let bytes: Buffer;
		try {
			bytes = await readInstructionFile(realFile, MAX_CREW_INSTRUCTIONS_FILE_BYTES);
		} catch (error) {
			throw new CrewManifestReadError(
				"instructions-file-unreadable",
				`members.${member.name}.instructionsFile could not be read`,
				{ cause: error },
			);
		}
		let after: Awaited<ReturnType<typeof fs.stat>>;
		try {
			after = await fs.stat(realFile);
		} catch (error) {
			throw new CrewManifestReadError(
				"instructions-file-changed",
				`members.${member.name}.instructionsFile changed while loading`,
				{ cause: error },
			);
		}
		if (bytes.byteLength > MAX_CREW_INSTRUCTIONS_FILE_BYTES || after.size > MAX_CREW_INSTRUCTIONS_FILE_BYTES)
			throw new CrewManifestReadError(
				"instructions-file-oversized",
				`members.${member.name}.instructionsFile exceeds ${MAX_CREW_INSTRUCTIONS_FILE_BYTES} bytes`,
			);
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
			throw new CrewManifestReadError(
				"instructions-file-changed",
				`members.${member.name}.instructionsFile changed while loading`,
			);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			throw new CrewManifestReadError(
				"instructions-file-invalid-encoding",
				`members.${member.name}.instructionsFile is not valid UTF-8`,
				{ cause: error },
			);
		}
		if (text.trim().length === 0)
			throw new CrewManifestReadError(
				"instructions-file-empty",
				`members.${member.name}.instructionsFile is blank`,
			);
		if (text.includes("\0"))
			throw new CrewManifestReadError(
				"instructions-file-nul",
				`members.${member.name}.instructionsFile contains NUL`,
			);
		members.push({ ...member, instructions: text, instructionsFile: undefined });
	}
	return { ...manifest, members };
}
