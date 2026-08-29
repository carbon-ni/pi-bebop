import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	canonicalCompactionDeliveryEnvelopeBytes,
	createCompactionDeliveryGate,
	isMessagePayload,
	type CompactionDeliveryEnvelope,
	type CompactionDeliveryGate,
	type CompactionDeliveryResult,
} from "../domain/index.ts";
import {
	openTrustedCompactionDeliveryJournal,
	type CompactionDeliveryJournal,
} from "../infra/compaction-delivery-journal.ts";
import type { Membership } from "../infra/membership-runtime.ts";

function parseDeliveryNumber(id: string): number {
	const match = /^delivery-(\\d+)$/.exec(id);
	return match ? Number(match[1]) : 0;
}

function requestIdForReplay(record: CompactionDeliveryEnvelope): string | undefined {
	if (typeof record.message !== "object" || record.message === null || Array.isArray(record.message))
		return undefined;
	const details = (record.message as Record<string, unknown>).details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	if (!isMessagePayload((details as Record<string, unknown>).messagePayload)) return undefined;
	const requestId = (details as Record<string, unknown>).crewRequestId;
	return typeof requestId === "string" ? requestId : undefined;
}

function hasDeliveryId(value: unknown, deliveryId: string, seen = new Set<object>()): boolean {
	if (typeof value !== "object" || value === null) return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => hasDeliveryId(item, deliveryId, seen));
	const record = value as Record<string, unknown>;
	if (record.deliveryId === deliveryId) return true;
	return (
		(record.metadata !== undefined && hasDeliveryId(record.metadata, deliveryId, seen)) ||
		(record.details !== undefined && hasDeliveryId(record.details, deliveryId, seen))
	);
}

export interface ModelDeliveryAdapter {
	readonly send: (
		message: unknown,
		options?: Readonly<Record<string, unknown>>,
		onDelivered?: () => void,
		onFailed?: () => void,
	) => CompactionDeliveryResult;
	readonly sendDurably: (
		message: unknown,
		options?: Readonly<Record<string, unknown>>,
		onDelivered?: () => void,
		onFailed?: () => void,
	) => Promise<CompactionDeliveryResult>;
	readonly configureJournal: (
		journal: CompactionDeliveryJournal | undefined,
		hasSessionEvidence?: (deliveryId: string) => Promise<boolean> | boolean,
		waitForSessionEvidence?: (deliveryId: string) => Promise<boolean> | boolean,
		isLiveRequest?: (requestId: string) => Promise<boolean> | boolean,
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
	isLiveRequest?: (requestId: string) => Promise<boolean> | boolean,
): Promise<void> {
	const journal = await openTrustedCompactionDeliveryJournal({
		manifestPath: membership.manifestPath,
		projectRoot: path.resolve(path.dirname(membership.manifestPath), "..", ".."),
		isProjectTrusted: () => context.isProjectTrusted(),
		memberName: membership.member.name,
	});
	const hasEvidence = async (deliveryId: string): Promise<boolean> =>
		(context.sessionManager.getEntries() as readonly unknown[]).some((entry) => hasDeliveryId(entry, deliveryId));
	const waitForEvidence = async (deliveryId: string): Promise<boolean> => {
		const deadline = Date.now() + 2_000;
		do {
			if (await hasEvidence(deliveryId)) return true;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		} while (Date.now() < deadline);
		return false;
	};
	await adapter.configureJournal(journal, hasEvidence, waitForEvidence, isLiveRequest);
}

/** Composition-root adapter: every Bebop model delivery crosses this gate. */
export function createModelDeliveryAdapter(send: ExtensionAPI["sendMessage"]): ModelDeliveryAdapter {
	let nextId = 0;
	let journal: CompactionDeliveryJournal | undefined;
	let waitForSessionEvidence: ((deliveryId: string) => Promise<boolean> | boolean) | undefined;
	let isLiveRequest: ((requestId: string) => Promise<boolean> | boolean) | undefined;
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
			let handedOff = false;
			try {
				const requestId = requestIdForReplay(entry);
				if (requestId && isLiveRequest && !(await isLiveRequest(requestId))) {
					await journal.markDelivered(entry.id);
					finish(entry.id, "failure");
					return;
				}
				await (persisted.get(entry.id) ?? Promise.resolve());
				await journal.markHandingOff(entry.id);
				send(decorateMessage(entry.message, entry.id) as never, entry.delivery as never);
				handedOff = true;
				const evidenceSeen = waitForSessionEvidence ? await waitForSessionEvidence(entry.id) : true;
				if (evidenceSeen) {
					try {
						await journal.markDelivered(entry.id);
					} catch {
						// Keep the handing-off record for evidence-based reconciliation.
					}
				}
				finish(entry.id, "success");
			} catch {
				finish(entry.id, handedOff ? "success" : "failure");
			}
			return;
		}
		try {
			send(entry.message as never, entry.delivery as never);
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
	const sendDurably = (
		message: unknown,
		options: Readonly<Record<string, unknown>> = {},
		onDelivered?: () => void,
		onFailed?: () => void,
	): Promise<CompactionDeliveryResult> =>
		new Promise((resolve) => {
			let persisted = false;
			const result = sendModel(
				message,
				options,
				onDelivered,
				onFailed,
				() => {
					persisted = true;
					resolve({ disposition: "deferred" });
				},
				() => resolve({ disposition: "invalid" }),
			);
			if (result.disposition !== "deferred" || !journal || persisted) resolve(result);
		});
	const sendModel = (
		message: unknown,
		options: Readonly<Record<string, unknown>> = {},
		onDelivered?: () => void,
		onFailed?: () => void,
		onPersisted?: () => void,
		onPersistenceFailed?: () => void,
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
					() => {
						onPersisted?.();
					},
					() => {
						onPersistenceFailed?.();
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
		sendDurably,
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
		configureJournal: async (
			nextJournal,
			hasSessionEvidence = async () => false,
			nextWaitForSessionEvidence,
			nextIsLiveRequest,
		) => {
			if (nextJournal === journal) return;
			if (nextJournal) {
				await nextJournal.reconcile(hasSessionEvidence);
				const pending = await nextJournal.listPending();
				const persistedNextId = nextJournal.nextSequence ? (await nextJournal.nextSequence()) - 1 : 0;
				gate.resetPending();
				journal = nextJournal;
				nextId = Math.max(nextId, persistedNextId, ...pending.map((record) => parseDeliveryNumber(record.id)));
				waitForSessionEvidence = nextWaitForSessionEvidence;
				isLiveRequest = nextIsLiveRequest;
				deferredIds.clear();
				persisted.clear();
				failed.clear();
				for (const record of pending) {
					const requestId = requestIdForReplay(record.envelope);
					if (requestId && nextIsLiveRequest && !(await nextIsLiveRequest(requestId))) {
						await nextJournal.markDelivered(record.id);
						continue;
					}
					deferredIds.add(record.id);
					gate.accept(record.envelope);
				}
				return;
			}
			gate.resetPending();
			journal = undefined;
			waitForSessionEvidence = undefined;
			isLiveRequest = undefined;
			deferredIds.clear();
			persisted.clear();
			failed.clear();
		},
		compactionStarted: () => gate.compactionStarted(),
		compactionEnded: (generation) => gate.compactionEnded(generation),
	};
}
