import type { InboxItem, InboxOffering } from "../domain/index.ts";
import type { InboxItemSummary, MemberInboxStore } from "../infra/member-inbox-store.ts";

/**
 * Durable inbox bridge (application operation behind /crew inbox and the
 * automatic offer triggers).
 *
 * Transport-only and trigger-driven: no scheduler, no timers, no idle probing,
 * no task/workflow semantics. Each trigger may offer the oldest pending item as
 * one normal follow-up; Pi owns turn ordering, and follow-ups already accepted
 * by Pi keep FIFO position because the offer enqueues with follow-up intent.
 *
 * Invariants:
 * - Removal is evidence-gated: an item is removed only when durable recipient
 *   session evidence contains its stable id (restart reconciliation closes the
 *   crash window between offer and removal).
 * - At most one item is outstanding at a time; repeated triggers are idempotent.
 * - Pause only stops automatic offering; reconciliation still runs and cancel
 *   still works. Cancel removes only pending items and is idempotent.
 * - Only the current endpoint owner consumes its queue: establish() records
 *   ownership and invalidate()/endpoint switches clear in-flight attempts.
 * - Malformed records are quarantined by the trusted store; this bridge maps
 *   store failures to bounded outcomes and never blocks healthy items.
 */

export interface InboxBridgeOwnership {
	readonly memberName: string;
	readonly memberRole: string;
	readonly socketPath: string;
	readonly manifestPath: string;
	readonly projectRoot: string;
}

export interface OfferingStateStore {
	readonly read: () => InboxOffering;
	readonly write: (offering: InboxOffering) => void;
}

export interface InboxBridgeDependencies {
	readonly openStore: (ownership: InboxBridgeOwnership) => Promise<MemberInboxStore>;
	readonly listEvidence: () => readonly string[];
	readonly offerItem: (item: InboxItem) => Promise<boolean>;
	readonly offeringState: OfferingStateStore;
	/** Optional recipient-owned settled/idle guard for automatic offers. */
	readonly isAuthoritativelyIdle?: () => boolean;
}

export type InboxOfferSkipReason = "not-joined" | "paused" | "no-items" | "outstanding" | "busy" | "failed";

export type InboxOfferOutcome =
	| { readonly offered: true; readonly itemId: string }
	| { readonly offered: false; readonly reason: InboxOfferSkipReason };

export interface InboxStatus {
	readonly offering: InboxOffering;
	readonly count: number;
	readonly outstanding: string | null;
	readonly items: readonly InboxItemSummary[];
}

export type InboxCancelOutcome =
	| { readonly removed: true; readonly itemId: string }
	| { readonly removed: false; readonly reason: "not-found" | "not-pending" };

export interface InboxBridgeController {
	establish(ownership: InboxBridgeOwnership | null): void;
	invalidate(): void;
	attemptOffer(): Promise<InboxOfferOutcome>;
	status(): Promise<InboxStatus>;
	cancel(itemId: string): Promise<InboxCancelOutcome>;
	setPaused(paused: boolean): void;
}

export function createInboxBridge(dependencies: InboxBridgeDependencies): InboxBridgeController {
	let ownership: InboxBridgeOwnership | null = null;
	let outstanding: string | null = null;

	const invalidate = (): void => {
		ownership = null;
		outstanding = null;
	};

	const establish = (next: InboxBridgeOwnership | null): void => {
		if (next === null) return invalidate();
		if (ownership?.socketPath !== next.socketPath) outstanding = null;
		ownership = next;
	};

	const attemptOfferUnlocked = async (): Promise<InboxOfferOutcome> => {
		if (!ownership) return { offered: false, reason: "not-joined" };
		let store: MemberInboxStore;
		try {
			store = await dependencies.openStore(ownership);
		} catch {
			return { offered: false, reason: "failed" };
		}
		try {
			const evidence = new Set(dependencies.listEvidence());
			const summaries = await store.list();
			for (const summary of summaries) {
				if (evidence.has(summary.id)) await store.remove(summary.id);
			}
			if (outstanding) {
				const stillPending = summaries.some((summary) => summary.id === outstanding);
				if (!stillPending || evidence.has(outstanding)) outstanding = null;
			}
			if (dependencies.offeringState.read() === "paused") return { offered: false, reason: "paused" };
			if (dependencies.isAuthoritativelyIdle && !dependencies.isAuthoritativelyIdle())
				return { offered: false, reason: "busy" };
			if (outstanding) return { offered: false, reason: "outstanding" };
			const oldest = await store.peekOldest();
			if (!oldest) return { offered: false, reason: "no-items" };
			const accepted = await dependencies.offerItem(oldest).catch(() => false);
			if (!accepted) return { offered: false, reason: "failed" };
			outstanding = oldest.id;
			return { offered: true, itemId: oldest.id };
		} catch {
			return { offered: false, reason: "failed" };
		}
	};

	// Serialize offer attempts and cancels so concurrent triggers (hint, turn_end,
	// restore) can never duplicate the same oldest item or cancel an in-flight offer.
	let operationTail: Promise<unknown> = Promise.resolve();
	const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
		const run = operationTail.then(operation, operation);
		operationTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const status = async (): Promise<InboxStatus> => {
		const offering = dependencies.offeringState.read();
		if (!ownership) return { offering, count: 0, outstanding: null, items: [] };
		try {
			const store = await dependencies.openStore(ownership);
			const [count, items] = await Promise.all([store.count(), store.list()]);
			return { offering, count, outstanding, items };
		} catch {
			return { offering, count: 0, outstanding: null, items: [] };
		}
	};

	const cancel = (itemId: string): Promise<InboxCancelOutcome> =>
		serialized(async () => {
			if (!ownership) return { removed: false, reason: "not-found" };
			if (outstanding === itemId) return { removed: false, reason: "not-pending" };
			if (dependencies.listEvidence().includes(itemId)) return { removed: false, reason: "not-pending" };
			try {
				const store = await dependencies.openStore(ownership);
				const result = await store.cancel(itemId);
				return result.removed ? { removed: true, itemId } : { removed: false, reason: "not-found" };
			} catch {
				return { removed: false, reason: "not-found" };
			}
		});

	const setPaused = (paused: boolean): void => {
		dependencies.offeringState.write(paused ? "paused" : "active");
	};

	const attemptOffer = (): Promise<InboxOfferOutcome> => serialized(attemptOfferUnlocked);

	return { establish, invalidate, attemptOffer, status, cancel, setPaused };
}

const DEFAULT_STATUS_LIMIT = 16;

/** Bounded status text: pending metadata only, never message contents. */
export function formatInboxStatus(status: InboxStatus, limit = DEFAULT_STATUS_LIMIT): string {
	const lines = [
		`Inbox ${status.offering} — ${status.count} pending${status.outstanding ? `; offering ${status.outstanding}` : ""}`,
	];
	const bounded = status.items.slice(0, Math.max(0, limit));
	for (const summary of bounded) {
		lines.push(
			`- ${summary.id} (seq ${summary.sequence}, ${new Date(summary.enqueuedAt).toISOString()}, ${summary.bytes} bytes)`,
		);
	}
	const omitted = status.items.length - bounded.length;
	if (omitted > 0) lines.push(`... ${omitted} more`);
	return lines.join("\n");
}
