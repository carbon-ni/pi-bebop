import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
	createExternalIntakePayload,
	resolveIntakeContact,
	CrewIntakeError,
	CrewManifestError,
	type CrewManifest,
} from "../domain/index.ts";
import {
	CrewManifestReadError,
	getTrustedCrewManifestPaths,
	readTrustedCrewManifestMetadata,
} from "../infra/crew-manifest-store.ts";
import {
	createCrewIntakeDropbox,
	CrewIntakeDropboxError,
	MAX_CREW_INTAKE_FILE_BYTES,
	type CrewIntakeDropbox,
} from "../infra/crew-intake-dropbox.ts";

export type ContactErrorCode =
	| "not-a-crew-project"
	| "invalid-manifest"
	| "external-intake-disabled"
	| "intake-not-initialized"
	| "invalid-payload"
	| "permission-denied"
	| "storage-unavailable";

export class ContactError extends Error {
	readonly code: ContactErrorCode;

	constructor(code: ContactErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ContactError";
		this.code = code;
	}
}

export interface ContactPublication {
	readonly submissionId: string;
	readonly state: "published" | "already-published";
	readonly bytes: number;
	readonly crew?: { readonly id: string; readonly displayName: string };
	readonly contact: { readonly name: string; readonly role: string };
}

export interface ContactRequest {
	readonly projectRoot: string;
	readonly content: string;
}

export interface ContactDependencies {
	readonly findManifest: (projectRoot: string) => Promise<string>;
	readonly readManifest: (manifestPath: string, projectRoot: string) => Promise<CrewManifest>;
	readonly createDropbox: (options: {
		manifestPath: string;
		projectRoot: string;
		isProjectTrusted: () => boolean;
	}) => CrewIntakeDropbox;
}

function mapManifestError(error: unknown): ContactError {
	if (error instanceof CrewManifestError)
		return new ContactError("invalid-manifest", "The Crew manifest is invalid; ask the Crew owner to repair it.", {
			cause: error,
		});
	if (error instanceof CrewManifestReadError)
		return new ContactError(
			error.code === "untrusted-project" || error.code === "untrusted-path"
				? "not-a-crew-project"
				: "invalid-manifest",
			error.code === "untrusted-project" || error.code === "untrusted-path"
				? "This directory is not a trusted Crew project. Change to the Crew project directory; remote contact is unsupported."
				: "The Crew manifest could not be read; ask the Crew owner to repair it.",
			{ cause: error },
		);
	return new ContactError(
		"invalid-manifest",
		"The Crew manifest could not be read; ask the Crew owner to repair it.",
		{
			cause: error,
		},
	);
}

function mapDropboxError(error: unknown): ContactError {
	if (error instanceof ContactError) return error;
	if (error instanceof CrewIntakeDropboxError) {
		if (
			["invalid-filename", "unsupported-file", "invalid-utf8", "empty-file", "nul-byte", "oversized"].includes(
				error.code,
			)
		)
			return new ContactError("invalid-payload", error.message, { cause: error });
		if (error.code === "permission-denied")
			return new ContactError("permission-denied", error.message, { cause: error });
		if (error.code === "not-found")
			return new ContactError(
				"intake-not-initialized",
				"Crew Intake is not initialized. Ask the owner to run `bebop crew init` in the Crew project.",
				{ cause: error },
			);
	}
	return new ContactError(
		"storage-unavailable",
		"Crew Intake could not publish the message. Check project permissions and retry.",
		{ cause: error },
	);
}

async function defaultFindManifest(projectRoot: string): Promise<string> {
	const candidates: string[] = [];
	for (const candidate of getTrustedCrewManifestPaths(projectRoot)) {
		try {
			const stat = await fs.lstat(candidate);
			if (stat.isFile() && !stat.isSymbolicLink()) candidates.push(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (candidates.length !== 1)
		throw new ContactError(
			"not-a-crew-project",
			candidates.length === 0
				? "No trusted Crew project was found here. Change to the Crew project directory; remote contact is unsupported."
				: "Multiple Crew manifests were found here. Use one trusted Crew project directory at a time.",
		);
	return candidates[0]!;
}

export const defaultContactDependencies: ContactDependencies = {
	findManifest: defaultFindManifest,
	readManifest: (manifestPath, projectRoot) => readTrustedCrewManifestMetadata(manifestPath, projectRoot, () => true),
	createDropbox: (options) => createCrewIntakeDropbox(options),
};

export function contactSubmissionId(content: string): string {
	return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

export async function submitContact(
	request: ContactRequest,
	dependencies: ContactDependencies = defaultContactDependencies,
): Promise<ContactPublication> {
	const manifestPath = await dependencies.findManifest(request.projectRoot);
	let manifest: CrewManifest;
	try {
		manifest = await dependencies.readManifest(manifestPath, request.projectRoot);
	} catch (error) {
		throw mapManifestError(error);
	}
	let resolution: ReturnType<typeof resolveIntakeContact>;
	try {
		resolution = resolveIntakeContact(manifest);
	} catch (error) {
		if (error instanceof CrewIntakeError && error.code === "unknown-contact")
			throw new ContactError(
				"invalid-manifest",
				"The Crew Intake contact is not a configured member; ask the Crew owner to repair intake.contact.",
				{ cause: error },
			);
		throw error;
	}
	if (!resolution.enabled)
		throw new ContactError(
			"external-intake-disabled",
			"This Crew has no configured Intake contact. Ask the owner to configure intake.contact.",
		);
	const submissionId = contactSubmissionId(request.content);
	const filename = `contact-${submissionId}.md`;
	try {
		// Validate the serialized message envelope before publishing. Raw file bytes
		// alone do not bound JSON escaping for control-heavy feedback.
		createExternalIntakePayload({ label: filename, content: request.content });
	} catch (error) {
		throw new ContactError(
			"invalid-payload",
			"Feedback exceeds the effective Crew Intake payload limit or is invalid.",
			{ cause: error },
		);
	}
	try {
		const dropbox = dependencies.createDropbox({
			manifestPath,
			projectRoot: request.projectRoot,
			isProjectTrusted: () => true,
		});
		const published = await dropbox.publish(filename, request.content);
		return {
			submissionId,
			state: published.state,
			bytes: published.bytes,
			...(manifest.crew === undefined
				? {}
				: { crew: { id: manifest.crew.id, displayName: manifest.crew.displayName } }),
			contact: { name: resolution.contact.name, role: resolution.contact.role },
		};
	} catch (error) {
		throw mapDropboxError(error);
	}
}

export { MAX_CREW_INTAKE_FILE_BYTES };
