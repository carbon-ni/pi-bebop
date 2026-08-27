import * as path from "node:path";

export const CREW_MANIFEST_VERSION = 1 as const;
export const CREW_MANIFEST_V2 = 2 as const;
export const DEFAULT_CREW_MANIFEST_FILE = "crew.json";

/** Maximum UTF-8 byte length of an optional inline crew-visible member description. */
export const MAX_MEMBER_DESCRIPTION_BYTES = 256;
export const MIN_RETROSPECTIVE_CADENCE_DAYS = 1;
export const MAX_RETROSPECTIVE_CADENCE_DAYS = 365;

export interface CrewMember {
	readonly name: string;
	readonly role: string;
	readonly socket: string;
	readonly socketPath: string;
	readonly instructions?: string;
	readonly instructionsFile?: string;
	/** Stable manifest-authored, crew-visible specialty/responsibility summary. */
	readonly description?: string;
}

export interface CrewPresenceConfig {
	readonly notifications: boolean;
}

/** Optional external intake: selects the exact crew contact by member name. */
export interface CrewIntakeConfig {
	readonly contact: string;
}

export interface CrewRetrospectiveConfig {
	/** Exact configured facilitator Member name; never a Role. */
	readonly facilitator: string;
	/** Optional exact 24-hour durations; omitted means manual-only. */
	readonly cadenceDays?: number;
}

export interface CrewAgreementsConfig {
	/** Source path retained until the trusted loader resolves its content. */
	readonly file?: string;
	/** Exact Current Crew Agreements bytes loaded by the trusted loader. */
	readonly content?: string;
	/** Optional retrospective scheduling configuration. */
	readonly retrospective?: CrewRetrospectiveConfig;
}

export interface CrewManifest {
	readonly version: typeof CREW_MANIFEST_VERSION | typeof CREW_MANIFEST_V2;
	readonly members: readonly CrewMember[];
	readonly presence: CrewPresenceConfig;
	readonly intake?: CrewIntakeConfig;
	/** Manifest-selected shared instructions, populated by the trusted loader. */
	readonly commonInstructions?: string;
	/** Source path retained until the trusted loader resolves its content. */
	readonly commonInstructionsFile?: string;
	/** Manifest-selected Current Crew Agreements, populated by the trusted loader. */
	readonly crewAgreements?: CrewAgreementsConfig;
}

export type CrewManifestErrorCode =
	| "invalid-manifest"
	| "invalid-version"
	| "invalid-members"
	| "invalid-member"
	| "invalid-socket-path"
	| "invalid-instructions-file"
	| "invalid-common-instructions-file"
	| "invalid-crew-agreements"
	| "invalid-retrospective-config"
	| "invalid-retrospective-facilitator"
	| "invalid-intake-config"
	| "invalid-intake-contact"
	| "duplicate-member-name"
	| "duplicate-socket-path";

export class CrewManifestError extends Error {
	readonly code: CrewManifestErrorCode;
	readonly manifestPath?: string;
	readonly validMemberNames?: readonly string[];

	constructor(
		code: CrewManifestErrorCode,
		message: string,
		details: { manifestPath?: string; validMemberNames?: readonly string[] } = {},
	) {
		super(message);
		this.name = "CrewManifestError";
		this.code = code;
		this.manifestPath = details.manifestPath;
		this.validMemberNames = details.validMemberNames;
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
		super(
			code === "no-match"
				? `no crew member matches socket path: ${socketPath}`
				: `duplicate crew members match socket path: ${socketPath}`,
		);
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

function requireDescription(value: unknown, field: string): string {
	if (typeof value !== "string") {
		invalid(`${field} must be a non-empty string`, "invalid-member");
	}
	const description = value;
	if (description.trim().length === 0) invalid(`${field} must be a non-empty string`, "invalid-member");
	if (description !== description.trim())
		invalid(`${field} must not have leading or trailing whitespace`, "invalid-member");
	if (/[\r\n]/.test(description)) invalid(`${field} must be a single line`, "invalid-member");
	if (description.includes("\0")) invalid(`${field} must not contain NUL`, "invalid-member");
	try {
		encodeURIComponent(description);
	} catch {
		invalid(`${field} must be valid Unicode`, "invalid-member");
	}
	if (Buffer.byteLength(description, "utf8") > MAX_MEMBER_DESCRIPTION_BYTES) {
		invalid(`${field} must be at most ${MAX_MEMBER_DESCRIPTION_BYTES} UTF-8 bytes`, "invalid-member");
	}
	return description;
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
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		invalid("member socket path must remain under the crew sockets directory", "invalid-socket-path");
	}
	return socketPath;
}

function isSupportedManifestVersion(value: unknown): value is typeof CREW_MANIFEST_VERSION | typeof CREW_MANIFEST_V2 {
	return value === CREW_MANIFEST_VERSION || value === CREW_MANIFEST_V2;
}

function validateCommonInstructionsFile(value: unknown, version: unknown, manifestPath: string): string | undefined {
	if (value === undefined) return undefined;
	if (version !== CREW_MANIFEST_V2)
		invalid("commonInstructionsFile requires manifest version 2", "invalid-common-instructions-file");
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0"))
		invalid("commonInstructionsFile must be a non-empty relative path", "invalid-common-instructions-file");
	if (path.isAbsolute(value)) invalid("commonInstructionsFile must be relative", "invalid-common-instructions-file");
	const instructionsRoot = path.resolve(path.dirname(manifestPath), "instructions");
	const resolved = path.resolve(path.dirname(manifestPath), value);
	const relative = path.relative(instructionsRoot, resolved);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		invalid(
			"commonInstructionsFile must remain under the instructions directory",
			"invalid-common-instructions-file",
		);
	}
	return value;
}

function validateRetrospectiveConfig(value: unknown): CrewRetrospectiveConfig {
	if (!isRecord(value)) invalid("retrospective must be an object", "invalid-retrospective-config");
	const keys = Object.keys(value);
	if (keys.some((key) => key !== "facilitator" && key !== "cadenceDays"))
		invalid("retrospective contains unsupported fields", "invalid-retrospective-config");
	const facilitator = value.facilitator;
	if (
		typeof facilitator !== "string" ||
		facilitator.trim().length === 0 ||
		facilitator !== facilitator.trim() ||
		facilitator.includes("\0")
	)
		invalid("retrospective.facilitator must be an exact Member name", "invalid-retrospective-config");
	const cadenceDays = value.cadenceDays;
	if (
		cadenceDays !== undefined &&
		(typeof cadenceDays !== "number" ||
			!Number.isSafeInteger(cadenceDays) ||
			cadenceDays < MIN_RETROSPECTIVE_CADENCE_DAYS ||
			cadenceDays > MAX_RETROSPECTIVE_CADENCE_DAYS)
	)
		invalid(
			`retrospective.cadenceDays must be an integer from ${MIN_RETROSPECTIVE_CADENCE_DAYS} to ${MAX_RETROSPECTIVE_CADENCE_DAYS}`,
			"invalid-retrospective-config",
		);
	return { facilitator, ...(cadenceDays === undefined ? {} : { cadenceDays: cadenceDays as number }) };
}

function validateCrewAgreements(
	value: unknown,
	version: unknown,
	manifestPath: string,
): CrewAgreementsConfig | undefined {
	if (value === undefined) return undefined;
	if (version !== CREW_MANIFEST_V2) invalid("crewAgreements requires manifest version 2", "invalid-crew-agreements");
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "file" && key !== "retrospective"))
		invalid("crewAgreements contains unsupported fields", "invalid-crew-agreements");
	if (typeof value.file !== "string")
		invalid("crewAgreements.file must be a non-empty relative path", "invalid-crew-agreements");
	if (value.file.trim().length === 0 || value.file.includes("\0") || path.isAbsolute(value.file))
		invalid("crewAgreements.file must be a non-empty relative path", "invalid-crew-agreements");
	const agreementsRoot = path.resolve(path.dirname(manifestPath), "agreements");
	const resolved = path.resolve(path.dirname(manifestPath), value.file);
	const relative = path.relative(agreementsRoot, resolved);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		invalid("crewAgreements.file must remain under the agreements directory", "invalid-crew-agreements");
	const retrospective =
		value.retrospective === undefined ? undefined : validateRetrospectiveConfig(value.retrospective);
	return { file: value.file, ...(retrospective === undefined ? {} : { retrospective }) };
}

function validateRetrospectiveFacilitator(
	crewAgreements: CrewAgreementsConfig | undefined,
	names: ReadonlySet<string>,
): void {
	const facilitator = crewAgreements?.retrospective?.facilitator;
	if (facilitator === undefined || names.has(facilitator)) return;
	throw new CrewManifestError(
		"invalid-retrospective-facilitator",
		`retrospective.facilitator must match an exact configured Member name: ${facilitator}`,
	);
}

export function parseCrewManifest(input: unknown, manifestPath = DEFAULT_CREW_MANIFEST_FILE): CrewManifest {
	if (!isRecord(input)) invalid("manifest must be an object");
	if (!isSupportedManifestVersion(input.version)) {
		throw new CrewManifestError("invalid-version", `unsupported manifest version: ${String(input.version)}`);
	}
	const version = input.version;
	const commonInstructionsFile = validateCommonInstructionsFile(input.commonInstructionsFile, version, manifestPath);
	const crewAgreements = validateCrewAgreements(input.crewAgreements, version, manifestPath);
	if (!Array.isArray(input.members) || input.members.length === 0) {
		throw new CrewManifestError("invalid-members", "members must be a non-empty array");
	}
	const rawPresence = input.presence;
	let presence: CrewPresenceConfig = { notifications: true };
	if (rawPresence !== undefined) {
		if (
			!isRecord(rawPresence) ||
			Object.keys(rawPresence).some((key) => key !== "notifications") ||
			typeof rawPresence.notifications !== "boolean"
		) {
			throw new CrewManifestError("invalid-manifest", "presence must contain only boolean notifications");
		}
		presence = { notifications: rawPresence.notifications };
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
		if (
			instructions !== undefined &&
			(typeof instructions !== "string" || instructions.trim().length === 0 || instructions.includes("\0"))
		) {
			invalid(`members[${index}].instructions must be a non-empty string without NUL`, "invalid-member");
		}
		const instructionsFile = rawMember.instructionsFile;
		if (
			instructionsFile !== undefined &&
			(typeof instructionsFile !== "string" ||
				instructionsFile.trim().length === 0 ||
				instructionsFile.includes("\0"))
		) {
			invalid(
				`members[${index}].instructionsFile must be a non-empty relative path`,
				"invalid-instructions-file",
			);
		}
		if (instructions !== undefined && instructionsFile !== undefined) {
			invalid(`members[${index}] must define only one of instructions or instructionsFile`, "invalid-member");
		}
		const rawDescription = rawMember.description;
		const validDescription =
			rawDescription === undefined
				? undefined
				: requireDescription(rawDescription, `members[${index}].description`);
		const validInstructions = typeof instructions === "string" ? instructions : undefined;
		const validInstructionsFile = typeof instructionsFile === "string" ? instructionsFile : undefined;
		if (validInstructionsFile !== undefined) {
			if (path.isAbsolute(validInstructionsFile))
				invalid(`members[${index}].instructionsFile must be relative`, "invalid-instructions-file");
			const instructionsRoot = path.resolve(path.dirname(manifestPath), "instructions");
			const resolved = path.resolve(path.dirname(manifestPath), validInstructionsFile);
			const relative = path.relative(instructionsRoot, resolved);
			if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
				invalid(
					`members[${index}].instructionsFile must remain under the instructions directory`,
					"invalid-instructions-file",
				);
			}
		}
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
			...(validInstructionsFile === undefined ? {} : { instructionsFile: validInstructionsFile }),
			...(validDescription === undefined ? {} : { description: validDescription }),
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

	let intake: CrewIntakeConfig | undefined;
	const rawIntake = input.intake;
	if (rawIntake !== undefined) {
		if (!isRecord(rawIntake)) invalid("intake must be an object", "invalid-intake-config");
		const keys = Object.keys(rawIntake);
		if (keys.length !== 1 || keys[0] !== "contact")
			invalid("intake must contain only the contact field", "invalid-intake-config");
		const contact = rawIntake.contact;
		if (
			typeof contact !== "string" ||
			contact.trim().length === 0 ||
			contact !== contact.trim() ||
			contact.includes("\0")
		)
			invalid("intake.contact must be a non-empty trimmed member name", "invalid-intake-config");
		if (!names.has(contact)) {
			const validMemberNames = members.map((member) => member.name);
			throw new CrewManifestError(
				"invalid-intake-contact",
				`Crew configuration invalid: manifest path ${manifestPath}; intake.contact rejected value '${contact}'; valid exact member names in manifest order: [${validMemberNames.join(", ")}]. Fixes: change intake.contact to one of those exact names, or add a member named '${contact}'; remove intake to disable external intake.`,
				{ manifestPath, validMemberNames },
			);
		}
		intake = { contact };
	}

	validateRetrospectiveFacilitator(crewAgreements, names);
	return {
		version,
		members,
		presence,
		...manifestOptionalFields(intake, commonInstructionsFile, crewAgreements),
	};
}

function manifestOptionalFields(
	intake: CrewIntakeConfig | undefined,
	commonInstructionsFile: string | undefined,
	crewAgreements: CrewAgreementsConfig | undefined,
): Partial<Pick<CrewManifest, "intake" | "commonInstructionsFile" | "crewAgreements">> {
	return {
		...(intake === undefined ? {} : { intake }),
		...(commonInstructionsFile === undefined ? {} : { commonInstructionsFile }),
		...(crewAgreements === undefined ? {} : { crewAgreements }),
	};
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
