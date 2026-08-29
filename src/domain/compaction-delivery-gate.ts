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

function canonicalJson(value: unknown, seen = new Set<object>()): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new TypeError("unsupported JSON value");
		return encoded;
	}
	if (typeof value !== "object") throw new TypeError("unsupported JSON value");
	if (seen.has(value)) throw new TypeError("circular JSON value");
	seen.add(value);
	try {
		if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`)
			.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

/** Canonical bytes persisted for one complete model-delivery envelope. */
export function canonicalCompactionDeliveryEnvelopeBytes(
	message: unknown,
	delivery: Readonly<Record<string, unknown>>,
	metadata: Readonly<Record<string, unknown>>,
): Uint8Array {
	return new TextEncoder().encode(canonicalJson({ delivery, message, metadata }) + "\n");
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
	isCompacting(): boolean;
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
		isCompacting: isClosed,
	};
}
