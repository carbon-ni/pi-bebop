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
	readonly configureJournal: (journal: CompactionDeliveryJournal | undefined) => Promise<void>;
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
	try {
		await adapter.configureJournal(
			await openTrustedCompactionDeliveryJournal({
				manifestPath: membership.manifestPath,
				projectRoot: path.resolve(path.dirname(membership.manifestPath), "..", ".."),
				isProjectTrusted: () => context.isProjectTrusted(),
				memberName: membership.member.name,
			}),
		);
	} catch {
		// Membership remains usable with the bounded in-memory gate.
	}
}

/** Composition-root adapter: every Bebop model delivery crosses this gate. */
export function createModelDeliveryAdapter(send: ExtensionAPI["sendMessage"]): ModelDeliveryAdapter {
	let nextId = 0;
	let journal: CompactionDeliveryJournal | undefined;
	const delivered = new Map<string, { success?: () => void; failure?: () => void }>();
	const deferredIds = new Set<string>();
	let gate: CompactionDeliveryGate;
	const deliver = (entry: CompactionDeliveryEnvelope): void => {
		if (journal && deferredIds.has(entry.id)) {
			const handoff = () => {
				send(entry.message as never, entry.delivery as never);
				void journal?.markDelivered(entry.id);
				deferredIds.delete(entry.id);
				const callbacks = delivered.get(entry.id);
				callbacks?.success?.();
				delivered.delete(entry.id);
			};
			void journal
				.append(entry, Date.now())
				.then(() => journal?.markHandingOff(entry.id))
				.then(handoff, () => {
					delivered.get(entry.id)?.failure?.();
					delivered.delete(entry.id);
				});
			return;
		}
		send(entry.message as never, entry.delivery as never);
		const callbacks = delivered.get(entry.id);
		deferredIds.delete(entry.id);
		callbacks?.success?.();
		delivered.delete(entry.id);
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
		if (result.disposition === "deferred" && shouldPersist) deferredIds.add(id);
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
		configureJournal: async (nextJournal) => {
			journal = nextJournal;
			if (!journal) return;
			await journal.reconcile(async () => false);
			for (const record of await journal.listPending()) {
				deferredIds.add(record.id);
				gate.accept(record.envelope);
			}
		},
		compactionStarted: () => gate.compactionStarted(),
		compactionEnded: (generation) => gate.compactionEnded(generation),
	};
}
