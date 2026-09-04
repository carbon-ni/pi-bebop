import { resolveGuestTarget, validateGuestMessageInput, type GuestMessageError } from "../domain/index.ts";
import type { GuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import type { RpcCommand, RpcCommandResponse } from "../domain/index.ts";

type GuestMessageDomainError = GuestMessageError;

/**
 * Crew-scoped Guest messaging application flow.
 *
 * Routing authority is the trusted crew manifest: the Guest resolves the
 * selected member's current configured endpoint directly and delivers a
 * `guest_send` command there. Authorization authority is the crew-owned
 * registry: the receiving Member fresh-validates crew, identity, callback
 * endpoint, capability digest, and current approval before delivery. There is
 * no relay, Inbox, sponsor, or broadcast fallback; offline endpoints fail
 * explicitly.
 */

export type GuestSendErrorCode =
	| GuestMessageDomainError["code"]
	| "not-approved"
	| "revoked"
	| "denied"
	| "pending"
	| "crew-mismatch"
	| "endpoint-mismatch"
	| "capability-mismatch"
	| "registry-unavailable"
	| "not-joined"
	| "offline"
	| "remote-rejected"
	| "invalid-ack"
	| "untrusted-project";

export class GuestSendError extends Error {
	readonly code: GuestSendErrorCode;

	constructor(code: GuestSendErrorCode, message: string) {
		super(message);
		this.name = "GuestSendError";
		this.code = code;
	}
}

export interface GuestManifestMember {
	readonly name: string;
	readonly role: string;
	readonly socketPath: string;
}

export interface GuestTrustedManifest {
	readonly crew?: { readonly id: string; readonly displayName: string };
	readonly members: readonly GuestManifestMember[];
}

export interface GuestMessageRequest {
	/** The Guest's crew-owned messaging runtime; source of send credentials. */
	readonly guestRuntime: GuestMembershipRuntime;
	readonly guestIdentity: string;
	/** Exact crew selector; there is no default, first, or recent fallback. */
	readonly crew: string;
	readonly target: string;
	readonly message: string;
	readonly instructions?: readonly string[];
	/** Loads the trusted crew manifest (routing authority) fail-closed. */
	readonly loadManifest: (crewId: string) => Promise<GuestTrustedManifest>;
	readonly signal?: AbortSignal;
}

export interface GuestMessageTransport {
	send(
		endpoint: string,
		command: RpcCommand,
		options?: { signal?: AbortSignal },
	): Promise<{ response: RpcCommandResponse }>;
}

export interface GuestMessageOutcome {
	readonly target: { name: string; role: string };
	readonly deliveryId: string;
	readonly disposition: "direct" | "queued" | "steered";
	readonly fromGuestName: string;
}

export interface GuestMessageDependencies {
	readonly transport: GuestMessageTransport;
}

function offlineCode(error: unknown): GuestSendErrorCode {
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "ENOENT" || systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return "offline";
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return "offline";
	return "offline";
}

function remoteRejectionCode(error: unknown): GuestSendErrorCode | null {
	if (error instanceof Error && error.name === "RpcProtocolError") {
		const message = error.message.replace(/^remote-error:\s*/, "").trim();
		if (message.length > 0) return message as GuestSendErrorCode;
	}
	return null;
}

export async function submitGuestMessage(
	request: GuestMessageRequest,
	dependencies: GuestMessageDependencies,
): Promise<GuestMessageOutcome> {
	const { crew } = validateGuestMessageInput({ crew: request.crew, message: request.message });
	const credentials = request.guestRuntime.credentials(crew);
	if (!credentials)
		throw new GuestSendError(
			"not-approved",
			`No approved Guest membership for crew ${crew}; messaging requires an approved binding`,
		);

	// Routing authority: the trusted crew manifest, read fail-closed at send time.
	let manifest: GuestTrustedManifest;
	try {
		manifest = await request.loadManifest(crew);
	} catch (error) {
		throw new GuestSendError(
			"offline",
			`trusted crew manifest for ${crew} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (manifest.crew && manifest.crew.id !== crew)
		throw new GuestSendError("crew-mismatch", `crew manifest ${manifest.crew.id} does not match selector ${crew}`);

	// Target resolution happens only inside the selected crew, after the
	// credential check, and never crosses crews.
	const resolved = resolveGuestTarget(
		manifest.members.map(({ name, role }) => ({ name, role })),
		request.target,
	);
	const endpoint = manifest.members.find((member) => member.name === resolved.name)?.socketPath;
	if (!endpoint)
		throw new GuestSendError(
			"offline",
			`selected member ${resolved.name} has no configured endpoint in crew ${crew}`,
		);

	const command: RpcCommand = {
		type: "guest_send",
		crewId: crew,
		guestIdentity: credentials.guestIdentity,
		callbackEndpoint: credentials.callbackEndpoint,
		capability: credentials.capability,
		target: resolved.name,
		content: request.message,
		...(request.instructions === undefined ? {} : { instructions: [...request.instructions] }),
	};
	let result: { response: RpcCommandResponse };
	try {
		result = await dependencies.transport.send(endpoint, command, { signal: request.signal });
	} catch (error) {
		const remoteCode = remoteRejectionCode(error);
		if (remoteCode) throw new GuestSendError(remoteCode, `Guest send rejected by ${resolved.name}: ${remoteCode}`);
		throw new GuestSendError(
			offlineCode(error),
			`Guest send to ${resolved.name} failed offline: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!result.response.success) {
		const code = (result.response.error ?? "remote-rejected") as GuestSendErrorCode;
		throw new GuestSendError(code, `Guest send rejected: ${result.response.error ?? code}`);
	}
	const data = result.response.data as { deliveryId?: unknown; disposition?: unknown; fromGuestName?: unknown };
	if (
		typeof data?.deliveryId !== "string" ||
		typeof data?.disposition !== "string" ||
		typeof data?.fromGuestName !== "string"
	)
		throw new GuestSendError("invalid-ack", "Member returned an invalid guest send acknowledgement");
	return {
		target: { name: resolved.name, role: resolved.role },
		deliveryId: data.deliveryId,
		disposition: data.disposition as GuestMessageOutcome["disposition"],
		fromGuestName: data.fromGuestName,
	};
}
