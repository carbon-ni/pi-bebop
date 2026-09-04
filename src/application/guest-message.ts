import {
	buildGuestBroadcastRecipients,
	resolveGuestTarget,
	validateGuestMessageInput,
	type GuestMessageError,
} from "../domain/index.ts";
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
	| "untrusted-project"
	| "no-recipients";

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
	/** Fresh crew-owned approved Guest roster, in registry order. */
	readonly approvedGuests?: readonly {
		readonly guestIdentity: string;
		readonly guestName: string;
		readonly callbackEndpoint: string;
	}[];
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
	/** Broadcast sends the same direct command to each selected recipient. */
	readonly kind?: "follow-up" | "broadcast";
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
		...(request.kind === undefined ? {} : { kind: request.kind }),
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

export type GuestBroadcastDisposition =
	| {
			readonly recipientName: string;
			readonly recipientRole: string;
			readonly disposition: "delivered";
			readonly deliveryId: string;
	  }
	| {
			readonly recipientName: string;
			readonly recipientRole: string;
			readonly disposition: "failed";
			readonly code: string;
			readonly message: string;
	  };

export interface GuestBroadcastOutcome {
	readonly ok: true;
	readonly dispositions: readonly GuestBroadcastDisposition[];
	readonly summary: { readonly delivered: number; readonly failed: number; readonly total: number };
}

function guestFailureCode(error: unknown): string {
	if (error instanceof GuestSendError) return error.code;
	return remoteRejectionCode(error) ?? offlineCode(error);
}

function guestFailureMessage(error: unknown, code: string): string {
	return error instanceof Error && error.message.length > 0 ? error.message : `Guest broadcast failed: ${code}`;
}

/**
 * Sends a transient Guest Broadcast directly to every approved participant in
 * the selected crew. Each recipient is attempted independently. Credentials
 * are re-read before every attempt so a local leave/revocation stops the
 * remaining fan-out; each receiving runtime performs its own fresh registry
 * authorization, including Guest recipients.
 */
export async function submitGuestBroadcast(
	request: Omit<GuestMessageRequest, "target">,
	dependencies: GuestMessageDependencies,
): Promise<GuestBroadcastOutcome> {
	const { crew } = validateGuestMessageInput({
		crew: request.crew,
		message: request.message,
		instructions: request.instructions,
	});
	const initialCredentials = request.guestRuntime.credentials(crew);
	if (!initialCredentials)
		throw new GuestSendError(
			"not-approved",
			`No approved Guest membership for crew ${crew}; messaging requires an approved binding`,
		);

	let manifest: GuestTrustedManifest;
	try {
		manifest = await request.loadManifest(crew);
	} catch (error) {
		throw new GuestSendError(
			"offline",
			`trusted crew manifest for ${crew} is unavailable: ${guestFailureMessage(error, "offline")}`,
		);
	}
	if (manifest.crew && manifest.crew.id !== crew)
		throw new GuestSendError("crew-mismatch", `crew manifest ${manifest.crew.id} does not match selector ${crew}`);
	const roster = buildGuestBroadcastRecipients({
		crewMembers: manifest.members,
		approvedGuests: (manifest.approvedGuests ?? []).map((guest) => ({
			identity: guest.guestIdentity,
			name: guest.guestName,
		})),
		sender: { kind: "guest", identity: initialCredentials.guestIdentity, name: initialCredentials.guestName },
	});
	if (roster.ok === false) throw new GuestSendError(roster.code, `Cannot broadcast: ${roster.code}`);

	const dispositions: GuestBroadcastDisposition[] = [];
	for (let index = 0; index < roster.recipients.length; index++) {
		const recipient = roster.recipients[index]!;
		const credentials = request.guestRuntime.credentials(crew);
		if (!credentials) {
			for (const remaining of roster.recipients.slice(index))
				dispositions.push({
					recipientName: remaining.name,
					recipientRole: remaining.kind === "member" ? remaining.role : "guest",
					disposition: "failed",
					code: "revoked",
					message: `Guest membership for ${crew} is no longer approved`,
				});
			break;
		}
		try {
			let outcome: GuestMessageOutcome;
			if (recipient.kind === "member") {
				outcome = await submitGuestMessage(
					{ ...request, target: recipient.name, kind: "broadcast" },
					dependencies,
				);
			} else {
				const guest = manifest.approvedGuests?.find(
					(candidate) => candidate.guestIdentity === recipient.identity,
				);
				if (!guest) throw new GuestSendError("not-approved", `Guest ${recipient.name} is no longer approved`);
				const response = await dependencies.transport.send(
					guest.callbackEndpoint,
					{
						type: "guest_send",
						crewId: crew,
						guestIdentity: credentials.guestIdentity,
						callbackEndpoint: credentials.callbackEndpoint,
						capability: credentials.capability,
						target: recipient.name,
						content: request.message,
						kind: "broadcast",
						...(request.instructions === undefined ? {} : { instructions: [...request.instructions] }),
					},
					{ signal: request.signal },
				);
				if (!response.response.success)
					throw new GuestSendError(
						(response.response.error ?? "remote-rejected") as GuestSendErrorCode,
						`Guest send rejected: ${response.response.error ?? "remote-rejected"}`,
					);
				const data = response.response.data as {
					deliveryId?: unknown;
					disposition?: unknown;
					fromGuestName?: unknown;
				};
				if (
					typeof data?.deliveryId !== "string" ||
					typeof data?.disposition !== "string" ||
					typeof data?.fromGuestName !== "string"
				)
					throw new GuestSendError("invalid-ack", "Guest recipient returned an invalid acknowledgement");
				outcome = {
					target: { name: recipient.name, role: "guest" },
					deliveryId: data.deliveryId,
					disposition: data.disposition as GuestMessageOutcome["disposition"],
					fromGuestName: data.fromGuestName,
				};
			}
			dispositions.push({
				recipientName: outcome.target.name,
				recipientRole: outcome.target.role,
				disposition: "delivered",
				deliveryId: outcome.deliveryId,
			});
		} catch (error) {
			dispositions.push({
				recipientName: recipient.name,
				recipientRole: recipient.kind === "member" ? recipient.role : "guest",
				disposition: "failed",
				code: guestFailureCode(error),
				message: guestFailureMessage(error, guestFailureCode(error)),
			});
		}
	}
	const failed = dispositions.filter((item) => item.disposition === "failed").length;
	return {
		ok: true,
		dispositions,
		summary: { delivered: dispositions.length - failed, failed, total: dispositions.length },
	};
}
