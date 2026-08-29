import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	canonicalCompactionDeliveryEnvelopeBytes,
	createCompactionDeliveryGate,
	type CompactionDeliveryEnvelope,
	type CompactionDeliveryGate,
	type CompactionDeliveryResult,
} from "../domain/index.ts";
import {
	openTrustedCompactionDeliveryJournal,
	type CompactionDeliveryJournal,
} from "../infra/compaction-delivery-journal.ts";
import type { Membership } from "../infra/membership-runtime.ts";

export interface ModelDeliveryAdapter {
	readonly send: (
		message: unknown,
		options?: Readonly<Record<string, unknown>>,
		onDelivered?: () => void,
		onFailed?: () => void,
	) => CompactionDeliveryResult;
	readonly configureJournal: (
		journal: CompactionDeliveryJournal | undefined,
		hasSessionEvidence?: (deliveryId: string) => Promise<boolean> | boolean,
	) => Promise<void>;
	readonly sendAndWait: (
		message: unknown,
		options?: Readonly<Record<string, unknown>>,
	) => Promise<CompactionDeliveryResult>;
	readonly compactionStarted: () => number;
	readonly compactionEnded: (generation: number) => boolean;
}

/** Configure receiver-owned persistence for the current trusted membership. */
export async function configureModelDeliveryJournal(
	adapter: ModelDeliveryAdapter,
	membership: Membership,
	context: ExtensionContext,
): Promise<void> {
	const journal = await openTrustedCompactionDeliveryJournal({
		manifestPath: membership.manifestPath,
		projectRoot: path.resolve(path.dirname(membership.manifestPath), "..", ".."),
		isProjectTrusted: () => context.isProjectTrusted(),
		memberName: membership.member.name,
	});
	await adapter.configureJournal(journal, async (deliveryId) =>
		(context.sessionManager.getEntries() as readonly unknown[]).some((entry) => {
			try {
				return JSON.stringify(entry).includes(deliveryId);
			} catch {
				return false;
			}
		}),
	);
}

/** Composition-root adapter: every Bebop model delivery crosses this gate. */
export function createModelDeliveryAdapter(send: ExtensionAPI["sendMessage"]): ModelDeliveryAdapter {
	let nextId = 0;
	let journal: CompactionDeliveryJournal | undefined;
	const delivered = new Map<string, { success?: () => void; failure?: () => void }>();
	const deferredIds = new Set<string>();
	const persisted = new Map<string, Promise<void>>();
	const failed = new Set<string>();
	let gate: CompactionDeliveryGate;
	const decorateMessage = (message: unknown, id: string): unknown => {
		if (!journal || typeof message !== "object" || message === null || Array.isArray(message)) return message;
		const source = message as Record<string, unknown>;
		const details = source.details;
		return {
			...source,
			details: {
				...(typeof details === "object" && details !== null && !Array.isArray(details) ? details : {}),
				deliveryId: id,
			},
		};
	};
	const finish = (id: string, callback: "success" | "failure"): void => {
		deferredIds.delete(id);
		if (callback === "failure") failed.add(id);
		persisted.delete(id);
		const callbacks = delivered.get(id);
		callbacks?.[callback]?.();
		delivered.delete(id);
	};
	const deliver = async (entry: CompactionDeliveryEnvelope): Promise<void> => {
		if (failed.has(entry.id)) {
			failed.delete(entry.id);
			return;
		}
		if (journal && deferredIds.has(entry.id)) {
			try {
				await (persisted.get(entry.id) ?? Promise.resolve());
				await journal.markHandingOff(entry.id);
				send(decorateMessage(entry.message, entry.id) as never, entry.delivery as never);
				await journal.markDelivered(entry.id);
				finish(entry.id, "success");
			} catch {
				finish(entry.id, "failure");
			}
			return;
		}
		try {
			send(decorateMessage(entry.message, entry.id) as never, entry.delivery as never);
			finish(entry.id, "success");
		} catch {
			finish(entry.id, "failure");
		}
	};
	gate = createCompactionDeliveryGate({
		maxEntries: 64,
		maxBytes: 70_400_000,
		maxEntryBytes: 1_100_000,
		schedule: (task) => setImmediate(task),
		deliver,
	});
	const sendModel = (
		message: unknown,
		options: Readonly<Record<string, unknown>> = {},
		onDelivered?: () => void,
		onFailed?: () => void,
	): CompactionDeliveryResult => {
		const id = `delivery-${++nextId}`;
		let bytes: number;
		try {
			bytes = canonicalCompactionDeliveryEnvelopeBytes(message, options, { deliveryId: id }).byteLength;
		} catch {
			return { disposition: "invalid" };
		}
		const envelope = { id, bytes, message, delivery: options, metadata: { deliveryId: id } };
		const shouldPersist = gate.isCompacting() || gate.pendingCount() > 0;
		if (onDelivered || onFailed) delivered.set(id, { success: onDelivered, failure: onFailed });
		const result = gate.accept(envelope);
		if (result.disposition === "deferred" && shouldPersist && journal) {
			deferredIds.add(id);
			persisted.set(
				id,
				journal.append(envelope, Date.now()).then(
					() => undefined,
					() => {
						finish(id, "failure");
					},
				),
			);
		}
		if (result.disposition === "invalid" || result.disposition === "capacity-exceeded") delivered.delete(id);
		return result;
	};
	return {
		send: sendModel,
		sendAndWait: (message, options = {}) =>
			new Promise((resolve, reject) => {
				const result = ((): CompactionDeliveryResult => {
					try {
						return sendModel(
							message,
							options,
							() => resolve({ disposition: "direct" }),
							() => reject(new Error("delivery-persistence-failed")),
						);
					} catch (error) {
						reject(error);
						return { disposition: "invalid" };
					}
				})();
				if (result.disposition === "invalid" || result.disposition === "capacity-exceeded")
					reject(new Error("delivery-failed"));
				else if (result.disposition === "direct" && !journal) resolve(result);
			}),
		configureJournal: async (nextJournal, hasSessionEvidence = async () => false) => {
			if (nextJournal === journal) return;
			gate.resetPending();
			journal = nextJournal;
			deferredIds.clear();
			persisted.clear();
			failed.clear();
			if (!journal) return;
			await journal.reconcile(hasSessionEvidence);
			for (const record of await journal.listPending()) {
				deferredIds.add(record.id);
				gate.accept(record.envelope);
			}
		},
		compactionStarted: () => gate.compactionStarted(),
		compactionEnded: (generation) => gate.compactionEnded(generation),
	};
}
