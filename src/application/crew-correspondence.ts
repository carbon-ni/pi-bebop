import {
	canonicalizeCrewManifestPath,
	createCrewCorrespondencePayload,
	type CrewIntakeError,
	type MessagePayload,
} from "../domain/index.ts";
import { ExternalIntakeError, persistIntakePayload, type ExternalIntakeDependencies } from "./external-intake.ts";

/**
 * Crew correspondence (application operation, TASK-0136).
 *
 * One durable crew-to-crew message from the currently joined Member to the
 * `intake.contact` of an absolute target Crew Manifest path. Reuses the
 * external-intake persistence seam (manifest load -> exact contact resolution
 * -> durable Inbox enqueue) and adds the correspondence contract:
 *
 * - Source identity (Member name/Role, canonical source manifest path, and
 *   optional Crew label) is derived from active Membership at execution time;
 *   the request carries no forgeable origin or return address.
 * - The payload carries a structured claimed Crew Return Address — never the
 *   callback-only `replyTo` — so the receiving Crew can reply by one explicit
 *   `send_to_crew` invocation. Each turn is a new one-way persisted message.
 * - Destination consent matches explicit-path external intake: exact supported
 *   layout + configured contact + filesystem permissions; never Pi project
 *   trust or authenticated remote identity.
 * - Success means persisted only: no endpoint probe, live notification,
 *   acknowledgement by recipient, or promised response.
 */

export type CrewCorrespondenceErrorCode =
	| "not-joined"
	| "non-absolute-target"
	| "self-target"
	| (typeof ExternalIntakeError.prototype.code extends infer T ? T : never);

export class CrewCorrespondenceError extends Error {
	readonly code: CrewCorrespondenceErrorCode;

	constructor(code: CrewCorrespondenceErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CrewCorrespondenceError";
		this.code = code;
	}
}

type CorrespondenceMember = { name: string; role: string };

export interface CrewCorrespondenceMembership {
	readonly member: CorrespondenceMember;
	/** Canonical absolute source manifest path from active Membership. */
	readonly manifestPath: string;
	readonly manifest: { readonly name?: string };
}

export interface CrewCorrespondenceRequest {
	readonly membership: CrewCorrespondenceMembership | null;
	readonly targetManifestPath: string;
	readonly message: string;
	readonly instructions?: readonly string[];
	readonly now: number;
}

export type CrewCorrespondenceDependencies = ExternalIntakeDependencies;

export interface CrewCorrespondenceOutcome {
	readonly ok: true;
	readonly itemId: string;
	readonly persisted: true;
	readonly contact: string;
	readonly contactRole: string;
	readonly targetManifestPath: string;
}

function correspondenceError(error: unknown): CrewCorrespondenceError {
	if (error instanceof ExternalIntakeError)
		return new CrewCorrespondenceError(error.code, error.message, { cause: error });
	if ((error as { name?: unknown })?.name === "CrewIntakeError")
		return new CrewCorrespondenceError(
			(error as { code: "unknown-contact" | "invalid-payload" }).code,
			error instanceof Error ? error.message : String(error),
			{ cause: error },
		);
	return new CrewCorrespondenceError("intake-storage-failed", `crew correspondence failed: ${String(error)}`, {
		cause: error,
	});
}

export async function sendCrewCorrespondence(
	request: CrewCorrespondenceRequest,
	dependencies: CrewCorrespondenceDependencies,
): Promise<CrewCorrespondenceOutcome> {
	if (!request.membership) throw new CrewCorrespondenceError("not-joined", "Not joined to a crew");
	const source = request.membership;

	const targetPath = canonicalizeCrewManifestPath(request.targetManifestPath);
	if (targetPath === null)
		throw new CrewCorrespondenceError(
			"non-absolute-target",
			`target crew manifest path must be a canonical absolute path: ${request.targetManifestPath}`,
		);
	const sourcePath = canonicalizeCrewManifestPath(source.manifestPath);
	if (targetPath === sourcePath)
		throw new CrewCorrespondenceError(
			"self-target",
			"target crew is your own crew: use crew-internal member tools instead",
		);

	let payload: MessagePayload;
	try {
		payload = createCrewCorrespondencePayload({
			source: {
				memberName: source.member.name,
				memberRole: source.member.role,
				manifestPath: sourcePath ?? source.manifestPath,
				crewName: source.manifest.name,
			},
			content: request.message,
			instructions: request.instructions,
		});
	} catch (error) {
		const intake = error as CrewIntakeError;
		throw new CrewCorrespondenceError("invalid-payload", intake.message, { cause: error });
	}

	try {
		const ack = await persistIntakePayload(payload, targetPath, { ...dependencies, now: () => request.now });
		return {
			ok: true,
			itemId: ack.itemId,
			persisted: true,
			contact: ack.contact,
			contactRole: ack.contactRole,
			targetManifestPath: targetPath,
		};
	} catch (error) {
		throw correspondenceError(error);
	}
}
