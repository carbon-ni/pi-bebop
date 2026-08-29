import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createCompactionDeliveryGate,
	type CompactionDeliveryEnvelope,
	type CompactionDeliveryGate,
	type CompactionDeliveryResult,
} from "../domain/index.ts";

export interface ModelDeliveryAdapter {
	readonly send: (message: unknown, options?: Readonly<Record<string, unknown>>) => CompactionDeliveryResult;
	readonly compactionStarted: () => number;
	readonly compactionEnded: (generation: number) => boolean;
}

function canonicalBytes(value: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

/** Composition-root adapter: every Bebop model delivery crosses this gate. */
export function createModelDeliveryAdapter(send: ExtensionAPI["sendMessage"]): ModelDeliveryAdapter {
	let nextId = 0;
	let gate: CompactionDeliveryGate;
	const deliver = (entry: CompactionDeliveryEnvelope): void => {
		void send(entry.message as never, entry.delivery as never);
	};
	gate = createCompactionDeliveryGate({
		maxEntries: 64,
		maxBytes: 70_400_000,
		maxEntryBytes: 1_100_000,
		schedule: (task) => setImmediate(task),
		deliver,
	});
	return {
		send(message, options = {}) {
			const id = `delivery-${++nextId}`;
			return gate.accept({
				id,
				bytes: canonicalBytes({ id, message, delivery: options, metadata: { deliveryId: id } }),
				message,
				delivery: options,
				metadata: { deliveryId: id },
			});
		},
		compactionStarted: () => gate.compactionStarted(),
		compactionEnded: (generation) => gate.compactionEnded(generation),
	};
}
