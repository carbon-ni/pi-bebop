import * as path from "node:path";
import type { CrewManifest } from "../domain/index.ts";

const MAX_CANDIDATES = 2;
const DISCOVERY_TIMEOUT_MS = 2_000;

export type CrewAvailability = "online" | "partial" | "offline" | "unknown" | "unaddressable";

export interface CrewDirectoryEntry {
	readonly selector?: string;
	readonly displayName?: string;
	readonly availability: CrewAvailability;
	readonly memberCount: number;
	readonly onlineMembers?: number;
	readonly observedAt?: string;
	readonly lastSeenAt?: string;
	/** Present only for duplicate selectors, where it is required for recovery. */
	readonly locator?: string;
	readonly addressable: boolean;
	readonly reason?: "missing-crew-id" | "invalid-manifest";
}

export interface CrewDirectoryObservation {
	readonly manifestPath: string;
	readonly lastSeenAt: string;
	readonly availability: "online" | "offline" | "unknown";
}

export interface CrewDirectoryLiveRuntime {
	readonly manifestPath: string;
	readonly observedAt: string;
	readonly availability: "online" | "offline" | "unknown";
}

export interface CrewDirectoryRequest {
	readonly projectRoot: string;
	readonly signal: AbortSignal;
}

export interface CrewDirectoryResult {
	readonly entries: readonly CrewDirectoryEntry[];
	readonly partial: boolean;
	readonly discovery?: "timeout" | "cancelled";
	readonly invalidCandidates?: number;
}

export interface CrewDirectoryDependencies {
	readonly discoverManifestPaths: (projectRoot: string) => readonly string[];
	readonly manifestExists: (manifestPath: string, projectRoot: string) => Promise<boolean>;
	readonly readManifest: (manifestPath: string, projectRoot: string) => Promise<CrewManifest>;
	readonly probeMember: (socketPath: string, signal?: AbortSignal) => Promise<boolean>;
	readonly readObservedLocators: (
		projectRoot: string,
		signal?: AbortSignal,
	) => Promise<readonly CrewDirectoryObservation[]>;
	readonly readLiveRuntimes: (
		projectRoot: string,
		signal?: AbortSignal,
	) => Promise<readonly CrewDirectoryLiveRuntime[]>;
	readonly now: () => Date;
}

type DiscoveryTermination = "timeout" | "cancelled";

interface DiscoveryWindow {
	readonly signal: AbortSignal;
	readonly termination: () => DiscoveryTermination | undefined;
	readonly close: () => void;
}

function createDiscoveryWindow(parentSignal: AbortSignal): DiscoveryWindow {
	const controller = new AbortController();
	let reason: DiscoveryTermination | undefined;
	const onParentAbort = () => {
		reason = "cancelled";
		controller.abort(parentSignal.reason);
	};
	if (parentSignal.aborted) onParentAbort();
	else parentSignal.addEventListener("abort", onParentAbort, { once: true });
	const timer = setTimeout(() => {
		reason = "timeout";
		controller.abort(new Error("Crew discovery timeout"));
	}, DISCOVERY_TIMEOUT_MS);
	return {
		signal: controller.signal,
		termination: () => reason,
		close: () => {
			clearTimeout(timer);
			parentSignal.removeEventListener("abort", onParentAbort);
		},
	};
}

async function withinDiscovery<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return undefined;
	}
	return await new Promise<T | undefined>((resolve, reject) => {
		let settled = false;
		const finish = (value: T | undefined) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(error);
		};
		const onAbort = () => finish(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(finish, fail);
	});
}

function availabilityFromProbe(online: number, total: number): CrewAvailability {
	if (total === 0) return "unknown";
	if (online === 0) return "offline";
	if (online === total) return "online";
	return "partial";
}

async function probeCrew(
	manifest: CrewManifest,
	deps: CrewDirectoryDependencies,
	signal: AbortSignal,
): Promise<{ availability: CrewAvailability; onlineMembers: number }> {
	if (signal.aborted) return { availability: "unknown", onlineMembers: 0 };
	const probes = Promise.all(
		manifest.members.map(async (member) => {
			try {
				return await deps.probeMember(member.socketPath, signal);
			} catch {
				return false;
			}
		}),
	).then((results) => {
		const onlineMembers = results.filter(Boolean).length;
		return { availability: availabilityFromProbe(onlineMembers, manifest.members.length), onlineMembers };
	});
	return (
		(await withinDiscovery(probes, signal)) ?? {
			availability: "unknown",
			onlineMembers: 0,
		}
	);
}

interface InternalEntry {
	readonly entry: CrewDirectoryEntry;
	readonly locator: string;
}

function exposeAmbiguityRecovery(rows: readonly InternalEntry[]): CrewDirectoryEntry[] {
	const counts = new Map<string, number>();
	for (const row of rows)
		if (row.entry.selector) counts.set(row.entry.selector, (counts.get(row.entry.selector) ?? 0) + 1);
	return rows.map(({ entry, locator }) =>
		entry.selector && counts.get(entry.selector)! > 1 ? { ...entry, locator } : entry,
	);
}

/** Discover trusted Crew directory entries without choosing a presentation format. */
export async function discoverCrewDirectory(
	request: CrewDirectoryRequest,
	deps: CrewDirectoryDependencies,
): Promise<CrewDirectoryResult> {
	const discovery = createDiscoveryWindow(request.signal);
	try {
		const projectRoot = path.resolve(request.projectRoot);
		const observedAt = deps.now().toISOString();
		const manifestPaths = deps.discoverManifestPaths(projectRoot).slice(0, MAX_CANDIDATES);
		const discoveredCandidates = discovery.signal.aborted
			? []
			: await withinDiscovery(
					Promise.all(
						manifestPaths.map(async (manifestPath) => ({
							manifestPath,
							exists: await deps.manifestExists(manifestPath, projectRoot),
						})),
					),
					discovery.signal,
				);
		const candidates = (discoveredCandidates ?? []).filter((candidate) => candidate.exists);
		const rows: InternalEntry[] = [];
		let invalidCandidates = 0;
		for (const candidate of candidates) {
			if (discovery.signal.aborted) break;
			try {
				const manifest = await withinDiscovery(
					deps.readManifest(candidate.manifestPath, projectRoot),
					discovery.signal,
				);
				if (manifest === undefined) break;
				const probed = await probeCrew(manifest, deps, discovery.signal);
				if (discovery.signal.aborted) break;
				rows.push({
					locator: candidate.manifestPath,
					entry: manifest.crew
						? {
								selector: manifest.crew.id,
								displayName: manifest.crew.displayName,
								availability: probed.availability,
								memberCount: manifest.members.length,
								onlineMembers: probed.onlineMembers,
								observedAt,
								addressable: true,
							}
						: {
								availability: "unaddressable",
								memberCount: manifest.members.length,
								onlineMembers: probed.onlineMembers,
								observedAt,
								addressable: false,
								reason: "missing-crew-id",
							},
				});
			} catch {
				if (discovery.signal.aborted) break;
				// Invalid candidates are partial-discovery evidence, not product rows.
				invalidCandidates += 1;
			}
		}
		const live = discovery.signal.aborted
			? []
			: ((await withinDiscovery(deps.readLiveRuntimes(projectRoot, discovery.signal), discovery.signal)) ?? []);
		const observed = discovery.signal.aborted
			? []
			: ((await withinDiscovery(deps.readObservedLocators(projectRoot, discovery.signal), discovery.signal)) ??
				[]);
		const records: Array<{
			manifestPath: string;
			observedAt: string;
			lastSeenAt?: string;
			availability: "online" | "offline" | "unknown";
		}> = [
			...live.map((row) => ({
				manifestPath: row.manifestPath,
				observedAt: row.observedAt,
				availability: row.availability,
			})),
			...observed.map((row) => ({
				manifestPath: row.manifestPath,
				observedAt: row.lastSeenAt,
				lastSeenAt: row.lastSeenAt,
				availability: row.availability,
			})),
		];
		for (const record of records) {
			if (discovery.signal.aborted) break;
			if (rows.some((row) => row.locator === record.manifestPath)) continue;
			try {
				const manifest = await withinDiscovery(
					deps.readManifest(record.manifestPath, projectRoot),
					discovery.signal,
				);
				if (manifest === undefined) break;
				if (!manifest.crew) continue;
				rows.push({
					locator: record.manifestPath,
					entry: {
						selector: manifest.crew.id,
						displayName: manifest.crew.displayName,
						availability: record.availability,
						memberCount: manifest.members.length,
						observedAt: record.observedAt,
						...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
						addressable: true,
					},
				});
			} catch {
				if (discovery.signal.aborted) break;
				invalidCandidates += 1;
			}
		}
		rows.sort(
			(a, b) =>
				(a.entry.selector ?? "").localeCompare(b.entry.selector ?? "") ||
				(a.entry.displayName ?? "").localeCompare(b.entry.displayName ?? "") ||
				a.locator.localeCompare(b.locator),
		);
		const entries = exposeAmbiguityRecovery(rows);
		const termination = discovery.termination();
		return {
			entries,
			partial: invalidCandidates > 0 || termination !== undefined,
			...(termination === undefined ? {} : { discovery: termination }),
			...(invalidCandidates > 0 ? { invalidCandidates } : {}),
		};
	} finally {
		discovery.close();
	}
}
