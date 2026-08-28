import {
	CrewManifestError,
	createExternalIntakePayload,
	resolveIntakeContact,
	type CrewManifest,
	type ExternalIntakeAck,
} from "../domain/index.ts";
import { CrewManifestReadError } from "../infra/crew-manifest-store.ts";
import { MemberInboxStoreError, type MemberInboxStore } from "../infra/member-inbox-store.ts";

/**
 * External crew intake (application operation, TASK-0041).
 *
 * Owns the whole external-intake path: manifest load + error mapping, exact
 * crew-contact resolution, claimed/unverified external payload attribution,
 * durable Inbox enqueue for the contact, and the one-way persisted
 * acknowledgement. It is trust-agnostic and ingress-independent: no CLI, Pi,
 * or TUI types; future local adapters supply their own manifest loader and
 * store opener and define their own trust/consent framing.
 *
 * One-way for MVP: the acknowledgement contains no reply route and promises
 * no response. No endpoint probe or running Pi session is required — the
 * contact may be offline; Inbox persists and TASK-0037 hands it over later.
 */

export type ExternalIntakeErrorCode =
	| "untrusted-path"
	| "read-failed"
	| "invalid-json"
	| "invalid-manifest"
	| "external-intake-disabled"
	| "unknown-contact"
	| "invalid-payload"
	| "inbox-full"
	| "inbox-untrusted"
	| "storage-unavailable"
	| "intake-storage-failed";

export class ExternalIntakeError extends Error {
	readonly code: ExternalIntakeErrorCode;

	constructor(code: ExternalIntakeErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ExternalIntakeError";
		this.code = code;
	}
}

export interface ExternalIntakeRequest {
	readonly manifestPath: string;
	readonly label: string;
	readonly content: string;
	readonly instructions?: readonly string[];
}

export interface ExternalIntakeDependencies {
	/** Loads and parses the crew manifest; throws CrewManifestReadError or CrewManifestError. */
	loadManifest(manifestPath: string): Promise<CrewManifest>;
	/** Opens the durable inbox store for the resolved contact member. */
	openStore(options: {
		manifestPath: string;
		projectRoot: string;
		member: { name: string; role: string; socketPath: string };
	}): Promise<MemberInboxStore>;
	now?(): number;
}

function projectRootOf(manifestPath: string): string {
	const normalized = manifestPath.split(/[\\/]/);
	return normalized.slice(0, -3).join("/") || "/";
}

function mapManifestLoadError(error: unknown): ExternalIntakeError {
	if (error instanceof CrewManifestError)
		return new ExternalIntakeError("invalid-manifest", error.message, { cause: error });
	if (error instanceof CrewManifestReadError) {
		if (error.code === "untrusted-path")
			return new ExternalIntakeError("untrusted-path", error.message, { cause: error });
		if (error.code === "read-failed")
			return new ExternalIntakeError("read-failed", error.message, { cause: error });
		if (error.code === "invalid-json")
			return new ExternalIntakeError("invalid-json", error.message, { cause: error });
		return new ExternalIntakeError("invalid-manifest", error.message, { cause: error });
	}
	return new ExternalIntakeError("invalid-manifest", `failed to load crew manifest: ${String(error)}`, {
		cause: error,
	});
}

function mapStoreOpenError(error: unknown): ExternalIntakeError {
	if (error instanceof MemberInboxStoreError) {
		if (error.code === "untrusted-project" || error.code === "untrusted-path")
			return new ExternalIntakeError("inbox-untrusted", error.message, { cause: error });
		return new ExternalIntakeError("intake-storage-failed", error.message, { cause: error });
	}
	return new ExternalIntakeError("intake-storage-failed", `failed to open contact inbox: ${String(error)}`, {
		cause: error,
	});
}

function mapEnqueueError(error: unknown): ExternalIntakeError {
	if (error instanceof MemberInboxStoreError) {
		if (error.code === "capacity-exceeded")
			return new ExternalIntakeError("inbox-full", error.message, { cause: error });
		if (error.code === "untrusted-project" || error.code === "untrusted-path")
			return new ExternalIntakeError("inbox-untrusted", error.message, { cause: error });
		if (
			error.code === "lock-conflict" ||
			error.code === "write-failed" ||
			error.code === "read-failed" ||
			error.code === "quarantine-failed"
		)
			return new ExternalIntakeError("storage-unavailable", error.message, { cause: error });
		return new ExternalIntakeError("intake-storage-failed", error.message, { cause: error });
	}
	return new ExternalIntakeError("intake-storage-failed", `failed to persist intake message: ${String(error)}`, {
		cause: error,
	});
}

export async function submitExternalIntake(
	request: ExternalIntakeRequest,
	dependencies: ExternalIntakeDependencies,
): Promise<ExternalIntakeAck> {
	let payload;
	try {
		payload = createExternalIntakePayload({
			label: request.label,
			content: request.content,
			instructions: request.instructions,
		});
	} catch {
		throw new ExternalIntakeError("invalid-payload", "external intake message is invalid");
	}
	return await persistIntakePayload(payload, request.manifestPath, dependencies);
}

/**
 * Shared intake persistence seam (TASK-0136): manifest load + error mapping,
 * exact crew-contact resolution, durable Inbox enqueue, and the one-way
 * persisted acknowledgement. Reused by external intake and crew
 * correspondence; throws the stable ExternalIntakeError vocabulary.
 */
export async function persistIntakePayload(
	payload: ReturnType<typeof createExternalIntakePayload>,
	manifestPath: string,
	dependencies: ExternalIntakeDependencies,
): Promise<ExternalIntakeAck> {
	let manifest: CrewManifest;
	try {
		manifest = await dependencies.loadManifest(manifestPath);
	} catch (error) {
		throw mapManifestLoadError(error);
	}

	const resolution = resolveIntakeContact(manifest);
	if (!resolution.enabled)
		throw new ExternalIntakeError(
			"external-intake-disabled",
			"external crew intake is disabled: the manifest has no configured crew contact",
		);
	const contact = resolution.contact;

	const projectRoot = projectRootOf(manifestPath);
	let store: MemberInboxStore;
	try {
		store = await dependencies.openStore({
			manifestPath,
			projectRoot,
			member: { name: contact.name, role: contact.role, socketPath: contact.socketPath },
		});
	} catch (error) {
		throw mapStoreOpenError(error);
	}

	let item;
	try {
		({ item } = await store.enqueue(payload, dependencies.now?.() ?? Date.now()));
	} catch (error) {
		throw mapEnqueueError(error);
	}

	return {
		ok: true,
		itemId: item.id,
		persisted: true,
		contact: contact.name,
		contactRole: contact.role,
	};
}
