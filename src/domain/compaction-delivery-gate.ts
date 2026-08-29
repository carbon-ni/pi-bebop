/**
 * Receiver-owned compaction delivery gate. This module owns only deterministic
 * state transitions; persistence and Pi integration are injected at the edge.
 */

/** Complete model-delivery envelope. The gate never interprets the message or metadata. */
export interface CompactionDeliveryEnvelope {
	readonly id: string;
	readonly bytes: number;
	readonly message: unknown;
	readonly delivery: Readonly<Record<string, unknown>>;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export type CompactionDeliveryResult =
	| { readonly disposition: "direct" }
	| { readonly disposition: "deferred" }
	| { readonly disposition: "capacity-exceeded" }
	| { readonly disposition: "invalid" };

export interface CompactionDeliveryGateOptions {
	readonly maxEntries: number;
	readonly maxBytes: number;
	readonly maxEntryBytes?: number;
	readonly schedule: (task: () => void) => void;
	readonly deliver: (entry: CompactionDeliveryEnvelope) => void;
}

export interface CompactionDeliveryGate {
	compactionStarted(): number;
	compactionEnded(generation: number): boolean;
	accept(entry: CompactionDeliveryEnvelope): CompactionDeliveryResult;
	pendingCount(): number;
	pendingBytes(): number;
}

export function createCompactionDeliveryGate(options: CompactionDeliveryGateOptions): CompactionDeliveryGate {
	const maxEntryBytes = options.maxEntryBytes ?? 1_100_000;
	const pending: CompactionDeliveryEnvelope[] = [];
	const pendingIds = new Set<string>();
	let pendingBytes = 0;
	let nextGeneration = 0;
	const activeGenerations: number[] = [];

	const isValidEntry = (entry: CompactionDeliveryEnvelope): boolean =>
		typeof entry.id === "string" &&
		entry.id.length > 0 &&
		Number.isSafeInteger(entry.bytes) &&
		entry.bytes >= 0 &&
		entry.bytes <= maxEntryBytes &&
		!pendingIds.has(entry.id);

	const isClosed = (): boolean => activeGenerations.length > 0;

	const drain = (generation: number): void => {
		if (isClosed() || generation !== nextGeneration) return;
		while (pending.length > 0) {
			if (isClosed() || generation !== nextGeneration) return;
			const entry = pending.shift()!;
			pendingIds.delete(entry.id);
			pendingBytes -= entry.bytes;
			options.deliver(entry);
		}
	};

	return {
		compactionStarted(): number {
			const generation = ++nextGeneration;
			activeGenerations.push(generation);
			return generation;
		},

		compactionEnded(generation: number): boolean {
			const current = activeGenerations.at(-1);
			if (current !== generation) return false;
			activeGenerations.pop();
			if (activeGenerations.length > 0) return true;
			const terminalGeneration = nextGeneration;
			options.schedule(() => drain(terminalGeneration));
			return true;
		},

		accept(entry: CompactionDeliveryEnvelope): CompactionDeliveryResult {
			if (!isValidEntry(entry)) return { disposition: "invalid" };
			if (!isClosed() && pending.length === 0) {
				options.deliver(entry);
				return { disposition: "direct" };
			}
			if (pending.length >= options.maxEntries || pendingBytes + entry.bytes > options.maxBytes)
				return { disposition: "capacity-exceeded" };
			pending.push(entry);
			pendingIds.add(entry.id);
			pendingBytes += entry.bytes;
			return { disposition: "deferred" };
		},

		pendingCount: () => pending.length,
		pendingBytes: () => pendingBytes,
	};
}
