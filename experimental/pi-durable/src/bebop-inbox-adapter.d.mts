import type { CrewManifest } from "../../../src/domain/crew-manifest.ts";
import type { InboxItem } from "../../../src/domain/member-inbox.ts";

export function readTrustedCrewManifestMetadata(
	manifestPath: string,
	projectRoot: string,
	isProjectTrusted: () => boolean,
): Promise<CrewManifest>;

export interface TrustedMemberInboxStore {
	enqueue(payload: unknown, now: number): Promise<{ readonly item: InboxItem }>;
	peekOldest(): Promise<InboxItem | null>;
	remove(id: string): Promise<{ readonly removed: boolean }>;
	count(): Promise<number>;
}

export function openTrustedMemberInboxStore(options: {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly member: { readonly name: string; readonly role: string; readonly socketPath: string };
}): Promise<TrustedMemberInboxStore>;

export function claimMemberEndpoint(endpointPath: string, targetSocketPath: string): Promise<unknown>;
export function releaseMemberEndpoint(endpointPath: string, targetSocketPath: string): Promise<void>;
export function probeMemberEndpoint(socketPath: string): Promise<boolean>;
