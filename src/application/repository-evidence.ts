import {
	MAX_REPOSITORY_EVIDENCE_CONTENT_BYTES,
	MAX_REPOSITORY_EVIDENCE_ITEMS,
	MAX_REPOSITORY_EVIDENCE_RAW_CONTENT_BYTES,
	MAX_REPOSITORY_EVIDENCE_REFERENCE_BYTES,
	REPOSITORY_EVIDENCE_SOURCES,
	RepositoryEvidenceAdapterError,
	canonicalRetrospectiveEvidenceJson,
	createRetrospectiveEvidence,
	isTimestampInRetrospectiveInterval,
	orderAndDeduplicateRetrospectiveEvidence,
	redactRetrospectiveEvidenceText,
	type CollectRepositoryEvidenceOptions,
	type RepositoryEvidenceAdapter,
	type RepositoryEvidenceArtifact,
	type RepositoryEvidenceSource,
	type RepositoryEvidenceSourceResult,
	type RetrospectiveEvidence,
	type RetrospectiveEvidenceFingerprint,
	type RetrospectiveEvidenceInterval,
} from "../domain/index.ts";

export {
	MAX_REPOSITORY_EVIDENCE_CONTENT_BYTES,
	MAX_REPOSITORY_EVIDENCE_ITEMS,
	MAX_REPOSITORY_EVIDENCE_RAW_CONTENT_BYTES,
	MAX_REPOSITORY_EVIDENCE_REFERENCE_BYTES,
	RepositoryEvidenceAdapterError,
} from "../domain/index.ts";
export type {
	CollectRepositoryEvidenceOptions,
	RepositoryEvidenceAdapter,
	RepositoryEvidenceArtifact,
	RepositoryEvidenceCaptureRequest,
	RepositoryEvidenceSource,
	RepositoryEvidenceSourceFailure,
	RepositoryEvidenceSourceResult,
	RepositoryMechanicalState,
	RepositoryStateAdapter,
} from "../domain/index.ts";

const SOURCES: readonly RepositoryEvidenceSource[] = REPOSITORY_EVIDENCE_SOURCES;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8Bytes(value: string): number {
	return encoder.encode(value).byteLength;
}
function boundedText(value: string, maxBytes = MAX_REPOSITORY_EVIDENCE_CONTENT_BYTES): string {
	const redactedPaths = value
		.replace(
			/(^|[\s=(])\/(?:Users|home|private|tmp|var|etc)\/[^\s,;]+/gim,
			(_match, prefix: string) => `${prefix}[REDACTED:path]`,
		)
		.replace(
			/(^|[\s=(])[A-Za-z]:\\(?:Users|Documents and Settings|Temp)\\[^\s,;]+/gim,
			(_match, prefix: string) => `${prefix}[REDACTED:path]`,
		);
	const redacted = redactRetrospectiveEvidenceText(redactedPaths).text.trim();
	const bytes = encoder.encode(redacted);
	if (bytes.byteLength <= maxBytes) return redacted;
	const omitted = bytes.byteLength - maxBytes;
	const marker = `\n[TRUNCATED:${omitted}-bytes]`;
	const markerBytes = utf8Bytes(marker);
	const budget = Math.max(0, maxBytes - markerBytes);
	let end = budget;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return `${decoder.decode(bytes.slice(0, end))}${marker}`;
}
function validBoundedText(value: string): boolean {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value === value.trim() &&
		!value.includes("\0") &&
		utf8Bytes(value) <= MAX_REPOSITORY_EVIDENCE_REFERENCE_BYTES
	);
}
function validRawContent(value: string): boolean {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value === value.trim() &&
		!value.includes("\0") &&
		utf8Bytes(value) <= MAX_REPOSITORY_EVIDENCE_RAW_CONTENT_BYTES
	);
}
function safeRelativePath(value: string): boolean {
	if (!validBoundedText(value)) return false;
	if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) return false;
	const parts = value.replaceAll("\\", "/").split("/");
	return parts.every((part) => part !== "" && part !== "." && part !== "..");
}
function validArtifact(item: RepositoryEvidenceArtifact, source: RepositoryEvidenceSource): boolean {
	return (
		item.source === source &&
		validBoundedText(item.id) &&
		validBoundedText(item.reference) &&
		validBoundedText(item.provenance) &&
		validRawContent(item.summary) &&
		(item.correlationId === undefined || validBoundedText(item.correlationId)) &&
		(item.relativePath === undefined || safeRelativePath(item.relativePath))
	);
}
function stableId(kind: string, semanticInput: unknown, fingerprint: RetrospectiveEvidenceFingerprint): string {
	const hash = fingerprint(canonicalRetrospectiveEvidenceJson(semanticInput));
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError("repository evidence fingerprint must be lowercase SHA-256");
	return `repository-${kind.replace(/[^a-z0-9-]/g, "-")}-${hash.slice(0, 24)}`;
}
function evidenceSort(a: RetrospectiveEvidence, b: RetrospectiveEvidence): number {
	return `${a.source.identity}:${a.source.reference}:${a.id}`.localeCompare(
		`${b.source.identity}:${b.source.reference}:${b.id}`,
	);
}
function freezeEvidence(values: readonly RetrospectiveEvidence[]): readonly RetrospectiveEvidence[] {
	return Object.freeze([...orderAndDeduplicateRetrospectiveEvidence(values)].sort(evidenceSort));
}

function outcomeEvidence(options: {
	repositoryId: string;
	interval: RetrospectiveEvidenceInterval;
	capturedAt: string;
	fingerprint: RetrospectiveEvidenceFingerprint;
	source: RepositoryEvidenceSource;
	result: RepositoryEvidenceSourceResult;
}): RetrospectiveEvidence {
	const { source, result } = options;
	const available = result.status === "available";
	const detail = available ? `available; records=${result.items.length}` : `${result.status}; ${result.detail}`;
	const common = {
		id: stableId("source-outcome", { repositoryId: options.repositoryId, source, detail }, options.fingerprint),
		interval: options.interval,
		source: {
			kind: "repository-artifact" as const,
			identity: `source-outcome:${source}`,
			reference: source,
		},
		capture: {
			capturedAt: options.capturedAt,
			collector: "repository-evidence-v1",
			provenance: boundedText(
				available ? result.provenance : (result.provenance ?? `adapter-outcome:${source}`),
				MAX_REPOSITORY_EVIDENCE_REFERENCE_BYTES,
			),
		},
	};
	return available
		? createRetrospectiveEvidence(
				{
					...common,
					availability: "captured",
					representation: {
						kind: "summary",
						text: `source outcome: ${detail}`,
					},
				},
				options.fingerprint,
			)
		: createRetrospectiveEvidence(
				{
					...common,
					availability: result.status === "unsupported" ? "unsupported" : "unavailable",
					gap: { reason: boundedText(`source outcome: ${detail}`) },
				},
				options.fingerprint,
			);
}

function invalidArtifactEvidence(
	options: CollectRepositoryEvidenceOptions,
	source: RepositoryEvidenceSource,
	item: RepositoryEvidenceArtifact,
): RetrospectiveEvidence {
	return createRetrospectiveEvidence(
		{
			id: stableId("invalid-artifact", { source, id: boundedText(String(item.id)) }, options.fingerprint),
			interval: options.interval,
			source: {
				kind: "repository-artifact",
				identity: `source-outcome:${source}`,
				reference: source,
			},
			availability: "unavailable",
			gap: {
				reason: "source outcome: failed; unsafe repository-relative path or malformed artifact",
			},
			capture: {
				capturedAt: options.capturedAt,
				collector: "repository-evidence-v1",
				provenance: `adapter-validation:${source}`,
			},
		},
		options.fingerprint,
	);
}

function artifactEvidence(
	options: CollectRepositoryEvidenceOptions,
	item: RepositoryEvidenceArtifact,
): RetrospectiveEvidence {
	const pathLine = item.relativePath === undefined ? "" : `\npath=${item.relativePath}`;
	const summary = boundedText(`kind=${item.source}; id=${item.id}${pathLine}\n${item.summary}`);
	const identity = boundedText(`${item.source}:${item.id}`, MAX_REPOSITORY_EVIDENCE_REFERENCE_BYTES);
	const reference = boundedText(item.correlationId ?? item.reference, MAX_REPOSITORY_EVIDENCE_REFERENCE_BYTES);
	const semantic = {
		repositoryId: options.repositoryId,
		source: item.source,
		id: identity,
		occurredAt: item.occurredAt,
		reference,
		path: item.relativePath,
		summary,
	};
	return createRetrospectiveEvidence(
		{
			id: stableId(item.source, semantic, options.fingerprint),
			interval: options.interval,
			source: {
				kind: "repository-artifact",
				identity,
				reference,
			},
			availability: "captured",
			representation: { kind: "summary", text: summary },
			capture: {
				capturedAt: options.capturedAt,
				collector: "repository-evidence-v1",
				provenance: boundedText(
					`source=${item.source}; snapshot=${item.provenance}`,
					MAX_REPOSITORY_EVIDENCE_REFERENCE_BYTES,
				),
			},
		},
		options.fingerprint,
	);
}

function errorMessage(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return fallback;
	const cleaned = error.message.replaceAll("\0", "�").trim();
	return cleaned.length === 0 ? fallback : cleaned;
}
function failureResult(source: RepositoryEvidenceSource, error: unknown): RepositoryEvidenceSourceResult {
	if (error instanceof RepositoryEvidenceAdapterError)
		return {
			status: error.code,
			detail: boundedText(errorMessage(error, "adapter failed without detail")),
			provenance: `adapter-error:${source}`,
		};
	return {
		status: "failed",
		detail: boundedText(errorMessage(error, "unknown adapter failure")),
		provenance: `adapter-error:${source}`,
	};
}
async function captureSource(
	source: RepositoryEvidenceSource,
	adapter: RepositoryEvidenceAdapter | undefined,
	interval: RetrospectiveEvidenceInterval,
): Promise<RepositoryEvidenceSourceResult> {
	if (adapter === undefined) return { status: "unsupported", detail: "missing adapter" };
	try {
		return await adapter.capture({
			interval,
			access: "read-only",
			networkAccess: "forbidden",
		});
	} catch (error) {
		return failureResult(source, error);
	}
}
function assertUniqueAdapters(adapters: readonly RepositoryEvidenceAdapter[]): void {
	const seen = new Set<RepositoryEvidenceSource>();
	for (const adapter of adapters) {
		if (!SOURCES.includes(adapter.source))
			throw new TypeError(`unsupported repository evidence adapter: ${adapter.source}`);
		if (seen.has(adapter.source)) throw new TypeError(`duplicate repository evidence adapter: ${adapter.source}`);
		seen.add(adapter.source);
	}
}

async function stateEvidence(options: CollectRepositoryEvidenceOptions): Promise<RetrospectiveEvidence | undefined> {
	if (options.state === undefined) return undefined;
	try {
		const state = await options.state({
			interval: options.interval,
			access: "read-only",
			networkAccess: "forbidden",
		});
		const detached = state.branch === null;
		const summary = boundedText(
			`repository state: head=${state.head}; branch=${state.branch ?? "detached"}; dirty=${state.dirty}; detached=${detached}; rewritten=${state.rewritten}`,
		);
		return createRetrospectiveEvidence(
			{
				id: stableId("state", { repositoryId: options.repositoryId, ...state }, options.fingerprint),
				interval: options.interval,
				source: {
					kind: "repository-artifact",
					identity: `repository-state:${state.head}`,
					reference: state.head,
				},
				availability: "captured",
				representation: { kind: "summary", text: summary },
				capture: {
					capturedAt: options.capturedAt,
					collector: "repository-evidence-v1",
					provenance: boundedText(state.provenance, MAX_REPOSITORY_EVIDENCE_REFERENCE_BYTES),
				},
			},
			options.fingerprint,
		);
	} catch (error) {
		const status = error instanceof RepositoryEvidenceAdapterError ? error.code : "failed";
		const detail = boundedText(errorMessage(error, "repository state unavailable"));
		return createRetrospectiveEvidence(
			{
				id: stableId(
					"state-outcome",
					{ repositoryId: options.repositoryId, status, detail },
					options.fingerprint,
				),
				interval: options.interval,
				source: {
					kind: "repository-artifact",
					identity: "repository-state-outcome",
					reference: options.repositoryId,
				},
				availability: status === "unsupported" ? "unsupported" : "unavailable",
				gap: { reason: `repository state outcome: ${status}; ${detail}` },
				capture: {
					capturedAt: options.capturedAt,
					collector: "repository-evidence-v1",
					provenance: "repository-state-adapter",
				},
			},
			options.fingerprint,
		);
	}
}

export async function collectRepositoryEvidence(
	options: CollectRepositoryEvidenceOptions,
): Promise<readonly RetrospectiveEvidence[]> {
	if (!validBoundedText(options.repositoryId)) throw new TypeError("invalid repository evidence repositoryId");
	const maxItems = options.maxItems ?? MAX_REPOSITORY_EVIDENCE_ITEMS;
	if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_REPOSITORY_EVIDENCE_ITEMS)
		throw new TypeError(`repository evidence maxItems must be within 1..${MAX_REPOSITORY_EVIDENCE_ITEMS}`);
	assertUniqueAdapters(options.adapters);
	const bySource = new Map(options.adapters.map((adapter) => [adapter.source, adapter]));
	const sourceResults = await Promise.all(
		SOURCES.map(async (source) => ({
			source,
			result: await captureSource(source, bySource.get(source), options.interval),
		})),
	);
	const evidence: RetrospectiveEvidence[] = sourceResults.map(({ source, result }) =>
		outcomeEvidence({
			repositoryId: options.repositoryId,
			interval: options.interval,
			capturedAt: options.capturedAt,
			fingerprint: options.fingerprint,
			source,
			result,
		}),
	);
	const artifacts = sourceResults
		.flatMap(({ source, result }) =>
			result.status === "available" ? result.items.map((item) => ({ source, item })) : [],
		)
		.filter(({ item }) => isTimestampInRetrospectiveInterval(item.occurredAt, options.interval))
		.sort((a, b) =>
			`${a.item.occurredAt}:${a.source}:${a.item.id}:${a.item.reference}`.localeCompare(
				`${b.item.occurredAt}:${b.source}:${b.item.id}:${b.item.reference}`,
			),
		);
	for (const { source, item } of artifacts.slice(0, maxItems)) {
		evidence.push(
			validArtifact(item, source)
				? artifactEvidence(options, item)
				: invalidArtifactEvidence(options, source, item),
		);
	}
	if (artifacts.length > maxItems) {
		evidence.push(
			createRetrospectiveEvidence(
				{
					id: stableId(
						"collector-limit",
						{
							repositoryId: options.repositoryId,
							omitted: artifacts.length - maxItems,
						},
						options.fingerprint,
					),
					interval: options.interval,
					source: {
						kind: "repository-artifact",
						identity: "source-outcome:collector-limit",
						reference: "repository-evidence-v1",
					},
					availability: "unavailable",
					gap: {
						reason: `source outcome: truncated; omitted=${artifacts.length - maxItems}`,
					},
					capture: {
						capturedAt: options.capturedAt,
						collector: "repository-evidence-v1",
						provenance: "deterministic-item-bound",
					},
				},
				options.fingerprint,
			),
		);
	}
	const state = await stateEvidence(options);
	if (state !== undefined) evidence.push(state);
	return freezeEvidence(evidence);
}
