import type { RetrospectiveEvidenceFingerprint, RetrospectiveEvidenceInterval } from "./retrospective-evidence.ts";

export const REPOSITORY_EVIDENCE_VERSION = 1 as const;
export const MAX_REPOSITORY_EVIDENCE_ITEMS = 256;
export const MAX_REPOSITORY_EVIDENCE_CONTENT_BYTES = 16 * 1024;
export const MAX_REPOSITORY_EVIDENCE_REFERENCE_BYTES = 2 * 1024;
export const MAX_REPOSITORY_EVIDENCE_RAW_CONTENT_BYTES = MAX_REPOSITORY_EVIDENCE_CONTENT_BYTES * 4;
export const REPOSITORY_EVIDENCE_SOURCES = [
	"git-commits",
	"plan-lifecycle",
	"retained-reports",
	"verification",
] as const;

export type RepositoryEvidenceSource = (typeof REPOSITORY_EVIDENCE_SOURCES)[number];
export type RepositoryEvidenceSourceFailure =
	| "missing"
	| "unsupported"
	| "failed"
	| "timeout"
	| "rotated"
	| "oversized";

export interface RepositoryEvidenceArtifact {
	readonly source: RepositoryEvidenceSource;
	readonly id: string;
	readonly occurredAt: string;
	readonly reference: string;
	readonly relativePath?: string;
	readonly summary: string;
	readonly provenance: string;
	readonly correlationId?: string;
}
export type RepositoryEvidenceSourceResult =
	| {
			readonly status: "available";
			readonly items: readonly RepositoryEvidenceArtifact[];
			readonly provenance: string;
	  }
	| { readonly status: RepositoryEvidenceSourceFailure; readonly detail: string; readonly provenance?: string };
export interface RepositoryEvidenceCaptureRequest {
	readonly interval: RetrospectiveEvidenceInterval;
	readonly access: "read-only";
	readonly networkAccess: "forbidden";
}
export interface RepositoryEvidenceAdapter {
	readonly source: RepositoryEvidenceSource;
	readonly capture: (request: RepositoryEvidenceCaptureRequest) => Promise<RepositoryEvidenceSourceResult>;
}
export interface RepositoryMechanicalState {
	readonly head: string;
	readonly branch: string | null;
	readonly dirty: boolean;
	readonly rewritten: boolean;
	readonly provenance: string;
}
export type RepositoryStateAdapter = (request: RepositoryEvidenceCaptureRequest) => Promise<RepositoryMechanicalState>;

export class RepositoryEvidenceAdapterError extends Error {
	readonly code: RepositoryEvidenceSourceFailure;
	constructor(code: RepositoryEvidenceSourceFailure, message: string) {
		super(message);
		this.name = "RepositoryEvidenceAdapterError";
		this.code = code;
	}
}

export interface CollectRepositoryEvidenceOptions {
	readonly repositoryId: string;
	readonly interval: RetrospectiveEvidenceInterval;
	readonly capturedAt: string;
	readonly fingerprint: RetrospectiveEvidenceFingerprint;
	readonly adapters: readonly RepositoryEvidenceAdapter[];
	readonly state?: RepositoryStateAdapter;
	readonly maxItems?: number;
}
