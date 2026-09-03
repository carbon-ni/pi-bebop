import {
	buildBroadcastRecipients,
	createBroadcastPayload,
	noRecipientsResult,
	summarizeBroadcastDispositions,
	validateBroadcastInput,
	type BroadcastDisposition,
	type CrewBroadcastResult,
} from "../domain/index.ts";
import {
	sendMemberMessage,
	MemberMessageError,
	type MemberMessageDependencies,
} from "./member-message.ts";
import type { CrewManifest, CrewMember } from "../domain/index.ts";

/** Live, non-interrupting broadcast fan-out application operation. */

export type BroadcastToCrewErrorCode = "not-joined" | "unknown-sender" | "invalid-request" | "no-recipients";

export class CrewBroadcastApplicationError extends Error {
	readonly code: BroadcastToCrewErrorCode;

	constructor(code: BroadcastToCrewErrorCode, message: string) {
		super(message);
		this.name = "CrewBroadcastApplicationError";
		this.code = code;
	}
}

export interface CrewBroadcastRequest {
	readonly membership: BroadcastMembership | null;
	readonly message: string;
	readonly instructions?: readonly string[];
	readonly signal?: AbortSignal;
}

export interface BroadcastMembership {
	readonly manifestPath: string;
	readonly socketPath: string;
	readonly member: CrewMember;
	readonly manifest: CrewManifest;
}

export interface BroadcastMessageDependencies extends MemberMessageDependencies {}

function failureCode(error: unknown): string {
	if (error instanceof MemberMessageError) return error.code;
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "ENOENT" || systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return "offline";
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return "timeout";
	return "transport-error";
}

function failureMessage(error: unknown, code: string): string {
	if (error instanceof Error && error.message.length > 0) return error.message;
	return code === "offline" ? "Member endpoint offline" : "Broadcast delivery failed";
}

/**
 * Fans one [broadcast] payload out as ordinary Follow-ups to every other
 * manifest member. Each recipient is attempted independently in manifest
 * order; no Inbox store, fallback, redirect, or interrupt is involved.
 */
export async function submitCrewBroadcast(
	request: CrewBroadcastRequest,
	dependencies: BroadcastMessageDependencies,
): Promise<CrewBroadcastResult> {
	if (!request.membership) throw new CrewBroadcastApplicationError("not-joined", "Not joined to a crew");
	const membership = request.membership;
	try {
		validateBroadcastInput({
			senderName: membership.member.name,
			content: request.message,
			instructions: request.instructions,
		});
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "invalid-request")
			throw new CrewBroadcastApplicationError("invalid-request", error.message);
		throw error;
	}
	const snapshot = buildBroadcastRecipients(membership.manifest, membership.member.name);
	if (snapshot.ok === false) return noRecipientsResult(snapshot.code);
	const payload = createBroadcastPayload(membership.member, {
		content: request.message,
		...(request.instructions === undefined ? {} : { instructions: request.instructions }),
	});
	const dispositions: BroadcastDisposition[] = [];
	for (const recipient of snapshot.recipients) {
		try {
			const outcome = await sendMemberMessage(
				{
					membership: membership as never,
					member: recipient.member.name,
					message: payload.content,
					instructions: payload.instructions,
					kind: "broadcast",
					intent: "follow_up",
					signal: request.signal,
				},
				dependencies,
			);
			dispositions.push({
				recipientName: recipient.member.name,
				recipientRole: recipient.member.role,
				deliveryId: outcome.deliveryId,
				disposition: "delivered",
			});
		} catch (error) {
			const code = failureCode(error);
			dispositions.push({
				recipientName: recipient.member.name,
				recipientRole: recipient.member.role,
				disposition: "failed",
				code,
				message: failureMessage(error, code),
			});
		}
	}
	return { ok: true, dispositions, summary: summarizeBroadcastDispositions(dispositions) };
}
