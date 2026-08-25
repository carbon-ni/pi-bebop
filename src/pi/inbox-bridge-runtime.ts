import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderMessagePayload, SESSION_MESSAGE_TYPE, type InboxItem, type InboxOffering } from "../domain/index.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import {
	createInboxBridge,
	type InboxBridgeController,
	type InboxBridgeDependencies,
	type InboxBridgeOwnership,
	type OfferingStateStore,
} from "../application/inbox-bridge.ts";
import { notifyAcceptedMessage, type SocketState } from "./control-runtime.ts";
import type { Membership } from "../infra/membership-runtime.ts";

export const INBOX_OFFERING_ENTRY_TYPE = "intray-inbox-offering";
const MAX_INBOX_EVIDENCE_ID_BYTES = 128;

export interface InboxBridgeRuntimeDependencies {
	readonly openStore?: typeof openTrustedMemberInboxStore;
	readonly isProjectTrusted?: () => boolean;
}

/** Ownership for the current member, derived from the live membership. */
export function ownershipFromMembership(membership: Membership): InboxBridgeOwnership {
	return {
		memberName: membership.member.name,
		memberRole: membership.member.role,
		socketPath: membership.socketPath,
		manifestPath: membership.manifestPath,
		projectRoot: path.resolve(path.dirname(membership.manifestPath), "..", ".."),
	};
}

const isSafeEvidenceId = (id: string): boolean =>
	id.length > 0 &&
	id.length <= MAX_INBOX_EVIDENCE_ID_BYTES &&
	!id.includes("/") &&
	!id.includes("\\") &&
	!id.includes("..") &&
	!id.includes("\0");

/** Durable recipient-session evidence: stable item ids from typed message details. */
export function collectInboxEvidence(entries: readonly unknown[]): readonly string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const candidate = entry as { type?: string; customType?: string; details?: unknown };
		if (candidate.type !== "custom_message" || candidate.customType !== SESSION_MESSAGE_TYPE) continue;
		const details = candidate.details as { inbox?: { itemId?: unknown } } | undefined;
		const itemId = details?.inbox?.itemId;
		if (typeof itemId !== "string" || !isSafeEvidenceId(itemId) || seen.has(itemId)) continue;
		seen.add(itemId);
		ids.push(itemId);
	}
	return ids;
}

/** Persisted offering state (last entry wins); defaults to active. */
export function latestOfferingState(entries: readonly unknown[]): InboxOffering {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== INBOX_OFFERING_ENTRY_TYPE) continue;
		const data = entry.data as { offering?: unknown } | undefined;
		if (data?.offering === "paused" || data?.offering === "active") return data.offering;
	}
	return "active";
}

/** Composes the application bridge with the Pi session surface. */
export function createInboxBridgeController(
	pi: ExtensionAPI,
	state: SocketState,
	dependencies: InboxBridgeRuntimeDependencies = {},
): InboxBridgeController {
	const isProjectTrusted = dependencies.isProjectTrusted ?? (() => state.context?.isProjectTrusted?.() === true);
	const openStore = dependencies.openStore ?? openTrustedMemberInboxStore;

	const entries = (): readonly unknown[] => state.context?.sessionManager.getEntries() ?? [];

	const offeringState: OfferingStateStore = {
		read: () => latestOfferingState(entries()),
		write: (offering) => pi.appendEntry(INBOX_OFFERING_ENTRY_TYPE, { offering }),
	};

	const bridgeDependencies: InboxBridgeDependencies = {
		openStore: async (ownership) =>
			openStore({
				manifestPath: ownership.manifestPath,
				projectRoot: ownership.projectRoot,
				isProjectTrusted,
				member: {
					name: ownership.memberName,
					role: ownership.memberRole,
					socketPath: ownership.socketPath,
				},
			}),
		listEvidence: () => collectInboxEvidence(entries()),
		offerItem: async (entry: InboxItem) => {
			const context = state.context;
			if (!context) return false;
			// TASK-0081: the inbox offer is a Bebop-owned model delivery; a local
			// blocking idle wait wakes on it before the unchanged message submits.
			notifyAcceptedMessage(state, `inbox-${entry.id}`);
			pi.sendMessage(
				{
					customType: SESSION_MESSAGE_TYPE,
					content: renderMessagePayload(entry.payload),
					display: true,
					details: { messagePayload: entry.payload, inbox: { itemId: entry.id } },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return true;
		},
		offeringState,
	};

	return createInboxBridge(bridgeDependencies);
}
