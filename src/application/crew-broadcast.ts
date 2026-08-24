import {
	buildBroadcastRecipients,
	createBroadcastId,
	createBroadcastPayload,
	noRecipientsResult,
	summarizeBroadcastDispositions,
	type BroadcastDisposition,
	type CrewBroadcastResult,
} from "../domain/index.ts";
import { MemberInboxStoreError, type MemberInboxStore } from "../infra/member-inbox-store.ts";
import type { CrewManifest, CrewMember } from "../domain/index.ts";

/**
 * Durable crew broadcast (application operation behind broadcast_to_crew).
 *
 * Internal fan-out: one non-interrupting message durably persisted to every
 * other configured member, in manifest order, regardless of presence. The
 * caller must already hold an active join membership; the operation never
 * probes endpoints and never redirects active work. This file contains no
 * Pi/TUI types — the transport seam is the injected store factory.
 *
 * Retry semantics follow the TASK-0042 contract: a stable broadcast id plus
 * deterministic per-recipient item ids make a retry after partial failure
 * idempotent — already-persisted recipients are skipped, missing recipients
 * are filled in, and no copy is ever duplicated. Every target reports a
 * disposition; partial success is an error outcome for the caller to surface,
 * never a silent total success.
 *
 * No-recipient and unknown-sender outcomes short-circuit before any storage
 * IO so a single-member crew cannot cause writes.
 */

export type BroadcastToCrewErrorCode = "not-joined" | "unknown-sender" | "invalid-request" | "untrusted-project";

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
	readonly now: number;
	readonly signal?: AbortSignal;
}

interface BroadcastMember {
	readonly name: string;
	readonly role: string;
	readonly socket: string;
	readonly socketPath: string;
}

export type { BroadcastMember };

export interface BroadcastMembership {
	readonly manifestPath: string;
	readonly socketPath: string;
	readonly member: CrewMember;
	readonly manifest: CrewManifest;
}

export interface BroadcastStoreDependencies {
	readonly isProjectTrusted: () => boolean;
	readonly openStore: (options: {
		readonly manifestPath: string;
		readonly projectRoot: string;
		readonly isProjectTrusted: () => boolean;
		readonly member: BroadcastMember;
	}) => Promise<MemberInboxStore>;
}

function projectRootOf(manifestPath: string): string {
	const normalized = manifestPath.split(/[\\/]/);
	return normalized.slice(0, -3).join("/") || "/";
}

const STORAGE_UNAVAILABLE = new Set(["lock-conflict", "write-failed", "read-failed", "quarantine-failed"]);

function mapStoreError(error: unknown, fallback = "storage-failed"): string {
	if (!(error instanceof MemberInboxStoreError)) return "storage-failed";
	switch (error.code) {
		case "capacity-exceeded":
			return "inbox-full";
		case "invalid-payload":
			return "invalid-payload";
		case "invalid-item-id":
			return "invalid-item-id";
		case "untrusted-path":
			return "inbox-untrusted-path";
		case "untrusted-project":
			return "untrusted-project";
	}
	if (STORAGE_UNAVAILABLE.has((error as MemberInboxStoreError).code)) return "storage-unavailable";
	if ((error as MemberInboxStoreError).code === "idempotency-conflict") return "idempotency-conflict";
	return fallback;
}

/**
 * Fans one message out to every other manifest member. Resolves to a
 * `CrewBroadcastResult` (TASK-0042 contract); `ok:false` means no recipients
 * and implies no storage IO was performed (single-member crew or unknown
 * sender).
 */
export async function submitCrewBroadcast(
	request: CrewBroadcastRequest,
	dependencies: BroadcastStoreDependencies,
): Promise<CrewBroadcastResult> {
	if (!request.membership) throw new CrewBroadcastApplicationError("not-joined", "Not joined to a crew");

	const { membership } = request;
	const senderName = membership.member.name;
	const instructions =
		request.instructions && request.instructions.length > 0 ? [...request.instructions] : undefined;

	// Stable idempotency key for the whole fan-out (TASK-0042).
	const broadcastId = createBroadcastId({
		senderName,
		content: request.message,
		...(instructions === undefined ? {} : { instructions }),
	});

	// Recipient snapshot in manifest order, sender excluded by canonical identity.
	const snapshot = buildBroadcastRecipients(membership.manifest, senderName, broadcastId);
	if (snapshot.ok === false) return noRecipientsResult(broadcastId, snapshot.code);

	if (!dependencies.isProjectTrusted())
		throw new CrewBroadcastApplicationError("untrusted-project", "Cannot broadcast in an untrusted project");

	// One payload shared by every recipient: content + ordered instructions + derived crew origin.
	const payload = createBroadcastPayload(membership.member, {
		content: request.message,
		...(instructions === undefined ? {} : { instructions }),
	});

	const dispositions: BroadcastDisposition[] = [];
	for (const recipient of snapshot.recipients) {
		if (request.signal?.aborted) {
			dispositions.push({
				recipientName: recipient.member.name,
				recipientRole: recipient.member.role,
				itemId: recipient.itemId,
				status: "failed",
				code: "aborted",
				message: "Broadcast aborted before recipient was reached",
			});
			continue;
		}
		await persistOne(recipient, dependencies, payload, request, dispositions);
		if (dispositions.at(-1)?.code === "idempotency-conflict") {
			for (const remaining of snapshot.recipients.slice(dispositions.length)) {
				dispositions.push({
					recipientName: remaining.member.name,
					recipientRole: remaining.member.role,
					itemId: remaining.itemId,
					status: "failed",
					code: "idempotency-conflict",
					message: "Broadcast stopped after an idempotency conflict",
				});
			}
			break;
		}
	}

	return { ok: true, broadcastId, dispositions, summary: summarizeBroadcastDispositions(dispositions) };
}

async function persistOne(
	recipient: { member: CrewMember; itemId: string },
	dependencies: BroadcastStoreDependencies,
	payload: ReturnType<typeof createBroadcastPayload>,
	request: { now: number; membership: BroadcastMembership },
	dispositions: BroadcastDisposition[],
): Promise<void> {
	const { member, itemId } = recipient;
	const fail = (code: string, message?: string) => {
		dispositions.push({
			recipientName: member.name,
			recipientRole: member.role,
			itemId,
			status: "failed" as const,
			code,
			message,
		});
	};
	try {
		const store = await dependencies.openStore({
			manifestPath: request.membership.manifestPath,
			projectRoot: projectRootOf(request.membership.manifestPath),
			isProjectTrusted: dependencies.isProjectTrusted,
			member: { name: member.name, role: member.role, socket: member.socket, socketPath: member.socketPath },
		});
		const result = await store.enqueueWithId(payload, request.now, itemId);
		if ("alreadyPersisted" in result) {
			dispositions.push({
				recipientName: member.name,
				recipientRole: member.role,
				itemId,
				status: "already-persisted",
			});
			return;
		}
		dispositions.push({ recipientName: member.name, recipientRole: member.role, itemId, status: "persisted" });
	} catch (error) {
		const code = mapStoreError(error);
		fail(code, error instanceof Error ? error.message : String(error));
	}
}
