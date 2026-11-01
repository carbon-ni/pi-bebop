import { createHash } from "node:crypto";
import { readlink } from "node:fs/promises";
import path from "node:path";
import type { CrewManifest } from "../../../src/domain/crew-manifest.ts";
import { renderMessagePayload } from "../../../src/domain/message-renderer.ts";
import type { InboxItem } from "../../../src/domain/member-inbox.ts";
import {
	claimMemberEndpoint,
	openTrustedMemberInboxStore,
	probeMemberEndpoint,
	readTrustedCrewManifestMetadata,
	releaseMemberEndpoint,
} from "./bebop-inbox-adapter.mjs";
export interface DurableInboxAdmission {
	(message: string, requestId: string, payloadHash: string): Promise<{ readonly submissionId: string }>;
}

export interface DurableInboxBridgeOptions {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly memberId: string;
	readonly hostSocketPath: string;
	readonly admit: DurableInboxAdmission;
	readonly dependencies?: Partial<DurableInboxBridgeDependencies>;
}

export interface DurableInboxBridgeDependencies {
	readonly loadManifest: typeof readTrustedCrewManifestMetadata;
	readonly openStore: typeof openTrustedMemberInboxStore;
	readonly claimEndpoint: typeof claimMemberEndpoint;
	readonly releaseEndpoint: typeof releaseMemberEndpoint;
	readonly isSocketAlive: typeof probeMemberEndpoint;
	readonly readEndpointTarget: typeof readlink;
}

export type DurableInboxDrainResult =
	| { readonly status: "empty" }
	| { readonly status: "admitted"; readonly itemId: string; readonly submissionId: string }
	| { readonly status: "already-removed"; readonly itemId: string; readonly submissionId: string }
	| { readonly status: "not-owner" };

export interface DurableInboxBridge {
	drainOne(): Promise<DurableInboxDrainResult>;
	close(): Promise<void>;
}

const defaultDependencies: DurableInboxBridgeDependencies = {
	loadManifest: readTrustedCrewManifestMetadata,
	openStore: openTrustedMemberInboxStore,
	claimEndpoint: claimMemberEndpoint,
	releaseEndpoint: releaseMemberEndpoint,
	isSocketAlive: probeMemberEndpoint,
	readEndpointTarget: readlink,
};

export function inboxRequestId(recipientIdentity: string, itemId: string, enqueuedAt: number): string {
	if (!recipientIdentity.trim() || !itemId.trim()) throw new Error("recipient identity and Inbox item ID must not be empty");
	if (!Number.isFinite(enqueuedAt) || enqueuedAt < 0) throw new Error("Inbox enqueue time must be a non-negative finite number");
	const digest = createHash("sha256")
		.update(canonicalJson({ recipient: path.resolve(recipientIdentity), itemId, enqueuedAt }))
		.digest("hex");
	return `bebop:${digest}`;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const fields = Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
		return `{${fields.join(",")}}`;
	}
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Inbox payload must be JSON serializable");
	return serialized;
}

function inboxPayloadHash(payload: unknown): string {
	return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function renderInboxAdmissionMessage(item: InboxItem): string {
	const enqueuedAt = new Date(item.enqueuedAt);
	const timestamp = Number.isFinite(enqueuedAt.getTime()) ? enqueuedAt.toISOString() : "unknown time";
	return [
		`[inbox] Enqueued at ${timestamp}.`,
		"Information only; no correlated Response is expected.",
		"Verify current relevance before acting; the item may be stale.",
		"",
		renderMessagePayload(item.payload),
	].join("\n");
}

function manifestMember(manifest: CrewManifest, memberId: string): CrewManifest["members"][number] {
	const member = manifest.members.find(({ name }) => name === memberId);
	if (!member) throw new Error(`member ${memberId} is not configured in the trusted crew manifest`);
	return member;
}

async function endpointTargetMatches(
	endpointPath: string,
	hostSocketPath: string,
	readEndpointTarget: typeof readlink,
): Promise<boolean> {
	try {
		const target = await readEndpointTarget(endpointPath);
		return path.resolve(path.dirname(endpointPath), target) === path.resolve(hostSocketPath);
	} catch {
		return false;
	}
}

/**
 * Connect the Durable host to one explicitly configured crew member's Inbox.
 * The host must already be listening on `hostSocketPath`. Project trust is
 * supplied by the caller; this adapter never invents or persists trust.
 */
export async function openDurableInboxBridge(options: DurableInboxBridgeOptions): Promise<DurableInboxBridge> {
	if (!options.memberId.trim()) throw new Error("memberId must not be empty");
	if (!options.isProjectTrusted()) throw new Error("cannot drain Inbox from an untrusted project");

	const dependencies = { ...defaultDependencies, ...options.dependencies };
	const manifest = await dependencies.loadManifest(
		options.manifestPath,
		options.projectRoot,
		options.isProjectTrusted,
	);
	const configuredMember = manifestMember(manifest, options.memberId);
	const store = await dependencies.openStore({
		manifestPath: options.manifestPath,
		projectRoot: options.projectRoot,
		isProjectTrusted: options.isProjectTrusted,
		member: {
			name: configuredMember.name,
			role: configuredMember.role,
			socketPath: configuredMember.socketPath,
		},
	});
	if (!(await dependencies.isSocketAlive(options.hostSocketPath))) {
		throw new Error("Durable member host socket must be listening before claiming the configured endpoint");
	}

	await dependencies.claimEndpoint(configuredMember.socketPath, options.hostSocketPath);

	let closed = false;
	let operationTail: Promise<unknown> = Promise.resolve();
	const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
		const run = operationTail.then(operation, operation);
		operationTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const ownsEndpoint = (): Promise<boolean> =>
		endpointTargetMatches(configuredMember.socketPath, options.hostSocketPath, dependencies.readEndpointTarget);

	const drainOne = (): Promise<DurableInboxDrainResult> =>
		serialized(async () => {
			if (closed || !options.isProjectTrusted()) throw new Error("Durable Inbox bridge is closed or project trust was revoked");
			if (!(await ownsEndpoint())) return { status: "not-owner" };

			const item = await store.peekOldest();
			if (!item) return { status: "empty" };
			if (!(await ownsEndpoint())) return { status: "not-owner" };

			const requestId = inboxRequestId(configuredMember.socketPath, item.id, item.enqueuedAt);
			const message = renderInboxAdmissionMessage(item);
			if (message.length > 8_000) throw new Error("Inbox message exceeds the Durable member's 8000-character limit");
			const admission = await options.admit(message, requestId, inboxPayloadHash(item.payload));
			if (!admission.submissionId) throw new Error("Durable Inbox admission did not return a receipt");
			if (!(await ownsEndpoint())) return { status: "not-owner" };

			const removed = await store.remove(item.id);
			if (!removed.removed)
				return { status: "already-removed", itemId: item.id, submissionId: admission.submissionId };
			return { status: "admitted", itemId: item.id, submissionId: admission.submissionId };
		});

	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await dependencies.releaseEndpoint(configuredMember.socketPath, options.hostSocketPath);
	};

	return { drainOne, close };
}
