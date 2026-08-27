import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DEFAULT_CREW_MANIFEST_FILE, parseCrewManifest, type CrewManifest } from "../domain/index.ts";
import {
	CONFIG_DIR_NAME,
	getCrewManifestPathFromSocketPath,
	getDefaultCrewManifestPath,
	getTrustedCrewManifestPaths,
	isTrustedCrewManifestPath,
	selectCrewSocketPath,
	type CrewSocketSelection,
} from "./crew-layout.ts";

export {
	CONFIG_DIR_NAME,
	getCrewManifestPathFromSocketPath,
	getDefaultCrewManifestPath,
	getTrustedCrewManifestPaths,
	isTrustedCrewManifestPath,
	selectCrewSocketPath,
	type CrewSocketSelection,
};

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
	| "instructions-file-changed"
	| "common-instructions-file-missing"
	| "common-instructions-file-unreadable"
	| "common-instructions-file-directory"
	| "common-instructions-file-unsafe"
	| "common-instructions-file-invalid-encoding"
	| "common-instructions-file-empty"
	| "common-instructions-file-nul"
	| "common-instructions-file-oversized"
	| "common-instructions-file-changed";

export class CrewManifestReadError extends Error {
	readonly code: CrewManifestReadErrorCode;

	constructor(code: CrewManifestReadErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CrewManifestReadError";
		this.code = code;
	}
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

type InstructionLabel = "instructionsFile" | "commonInstructionsFile";

function instructionErrorCode(label: InstructionLabel, suffix: string): CrewManifestReadErrorCode {
	if (label === "instructionsFile") return `instructions-file-${suffix}` as CrewManifestReadErrorCode;
	return `common-instructions-file-${suffix}` as CrewManifestReadErrorCode;
}

function instructionMessage(label: InstructionLabel, memberName: string | undefined, detail: string): string {
	const field = memberName ? `members.${memberName}.${label}` : label;
	return `${field} ${detail}`;
}

function failInstruction(
	label: InstructionLabel,
	memberName: string | undefined,
	suffix: string,
	detail: string,
	cause?: unknown,
): never {
	throw new CrewManifestReadError(
		instructionErrorCode(label, suffix),
		instructionMessage(label, memberName, detail),
		{
			cause,
		},
	);
}

function validateInstructionStat(
	stat: Awaited<ReturnType<typeof fs.stat>>,
	label: InstructionLabel,
	memberName: string | undefined,
): void {
	if (stat.isDirectory()) failInstruction(label, memberName, "directory", "is a directory");
	if (!stat.isFile()) failInstruction(label, memberName, "unreadable", "is not a regular file");
	if (stat.size > MAX_CREW_INSTRUCTIONS_FILE_BYTES)
		failInstruction(label, memberName, "oversized", `exceeds ${MAX_CREW_INSTRUCTIONS_FILE_BYTES} bytes`);
}

function decodeInstruction(bytes: Buffer, label: InstructionLabel, memberName: string | undefined): string {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		failInstruction(label, memberName, "invalid-encoding", "is not valid UTF-8", error);
	}
	if (text.trim().length === 0) failInstruction(label, memberName, "empty", "is blank");
	if (text.includes("\0")) failInstruction(label, memberName, "nul", "contains NUL");
	return text;
}

async function loadInstructionFile(
	filePath: string,
	instructionsRoot: string,
	label: InstructionLabel,
	memberName: string | undefined,
	readInstructionFile: ReadInstructionFile,
): Promise<string> {
	let realFile: string;
	try {
		realFile = await fs.realpath(filePath);
	} catch (error) {
		const suffix = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
		failInstruction(label, memberName, suffix, "could not be resolved", error);
	}
	const relative = path.relative(instructionsRoot, realFile);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		failInstruction(label, memberName, "unsafe", "is outside instructions/");
	let before: Awaited<ReturnType<typeof fs.stat>>;
	try {
		before = await fs.stat(realFile);
	} catch (error) {
		const suffix = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
		failInstruction(label, memberName, suffix, "could not be read", error);
	}
	validateInstructionStat(before, label, memberName);
	let bytes: Buffer;
	try {
		bytes = await readInstructionFile(realFile, MAX_CREW_INSTRUCTIONS_FILE_BYTES);
	} catch (error) {
		failInstruction(label, memberName, "unreadable", "could not be read", error);
	}
	let after: Awaited<ReturnType<typeof fs.stat>>;
	try {
		after = await fs.stat(realFile);
	} catch (error) {
		failInstruction(label, memberName, "changed", "changed while loading", error);
	}
	if (bytes.byteLength > MAX_CREW_INSTRUCTIONS_FILE_BYTES || after.size > MAX_CREW_INSTRUCTIONS_FILE_BYTES)
		failInstruction(label, memberName, "oversized", `exceeds ${MAX_CREW_INSTRUCTIONS_FILE_BYTES} bytes`);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
		failInstruction(label, memberName, "changed", "changed while loading");
	return decodeInstruction(bytes, label, memberName);
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
	const hasRoleFiles = manifest.members.some((member) => member.instructionsFile !== undefined);
	if (manifest.commonInstructionsFile === undefined && !hasRoleFiles) return manifest;
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
	let commonInstructions: string | undefined;
	if (manifest.commonInstructionsFile !== undefined) {
		commonInstructions = await loadInstructionFile(
			path.resolve(crewRoot, manifest.commonInstructionsFile),
			realInstructionsRoot,
			"commonInstructionsFile",
			undefined,
			readInstructionFile,
		);
	}
	const members = [] as CrewManifest["members"] extends readonly (infer T)[] ? T[] : never;
	for (const member of manifest.members) {
		if (member.instructionsFile === undefined) {
			members.push(member);
			continue;
		}
		const instructions = await loadInstructionFile(
			path.resolve(crewRoot, member.instructionsFile),
			realInstructionsRoot,
			"instructionsFile",
			member.name,
			readInstructionFile,
		);
		members.push({ ...member, instructions, instructionsFile: undefined });
	}
	return {
		...manifest,
		members,
		...(commonInstructions === undefined ? {} : { commonInstructions, commonInstructionsFile: undefined }),
	};
}
