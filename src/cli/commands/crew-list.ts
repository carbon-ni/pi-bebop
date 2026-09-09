import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { CrewManifestError, parseCrewManifest, type CrewManifest } from "../../domain/index.ts";
import { probeMemberEndpoint } from "../../infra/member-endpoint.ts";
import { getTrustedCrewManifestPaths, isTrustedCrewManifestPath } from "../../infra/crew-layout.ts";
import { getLiveSessions } from "../../infra/control-store.ts";
import { sendRpcCommand } from "../../infra/rpc-client.ts";
import { CrewManifestReadError } from "../../infra/crew-manifest-store.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome, CliResult } from "../support/output.ts";

const MAX_CANDIDATES = 2;
const MAX_OUTPUT_CREWS = 100;
const PROBE_TIMEOUT_MS = 300;
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

export interface CrewListCliOptions {
	readonly command: "crew-list";
	readonly format: CliFormat;
	readonly full: boolean;
	readonly help?: boolean;
}

export interface CrewListDependencies {
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

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export function buildCrewListCommand(): Command {
	return new Command("list")
		.description("List locally known Crews by public identity")
		.option(
			"--format <format>",
			"Output format: toon (default), json, or text",
			defaultFormatForCommand("crew-list"),
		)
		.option("--full", "Full response without response truncation")
		.showHelpAfterError(false)
		.helpOption(false);
}

export function crewListHelp(): string {
	return [
		"pi-bebop crew list [--format toon|json|text] [--full]",
		"",
		"List trusted locally known Crews by stable selector, display name,",
		"availability, configured Member count, and freshness. Display names are",
		"informative only; use the exact Crew selector for routing.",
		"",
		"Discovery is bounded to .pi/bebop/crew.json and the .pi/crew/crew.json",
		"compatibility layout in the current project. It never scans arbitrary",
		"projects or exposes session IDs, sockets, endpoints, capabilities, or",
		"Request IDs. Duplicate selectors show only the Locator recovery values.",
		"",
		"Options:",
		"  --format <format>   toon (default), json, or text",
		"  --full              Full response without response truncation",
		"",
		"Examples:",
		"  pi-bebop crew list --format text",
		"  pi-bebop crew list --format json --full",
		"",
	].join("\n");
}

export function readCrewListCommand(parsed: Command): CrewListCliOptions {
	const options = parsed.opts<{ format?: string; full?: boolean }>();
	const format = (options.format ?? defaultFormatForCommand("crew-list")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return { command: "crew-list", format, full: options.full === true };
}

export function parseCrewListCommand(args: string[], _cwd = process.cwd()): CrewListCliOptions {
	const tokens: string[] = [];
	let help = false;
	let full = false;
	let seenFormat = false;
	for (const raw of args) {
		const equals = raw.indexOf("=");
		const flag = equals > 0 ? raw.slice(0, equals) : raw;
		if (flag === "--help") {
			if (help) throw new UsageError("Duplicate flag: --help");
			help = true;
			continue;
		}
		if (flag === "--full") {
			if (full) throw new UsageError("Duplicate flag: --full");
			full = true;
			tokens.push(raw);
			continue;
		}
		if (flag === "--format") {
			if (seenFormat) throw new UsageError("Duplicate flag: --format");
			seenFormat = true;
			tokens.push(raw);
			continue;
		}
		tokens.push(raw);
	}
	const program = buildCrewListCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	let options: { format?: string };
	try {
		program.parse(tokens, { from: "user" });
		options = program.opts();
	} catch (error) {
		if (error instanceof Error && error.name === "CommanderError") {
			const match = /--[a-z-]+/.exec(error.message);
			const flag = match?.[0] ?? "--format";
			throw new UsageError(
				(error as Error & { code?: string }).code === "commander.optionMissingArgument"
					? `Missing value for ${flag}`
					: error.message,
			);
		}
		throw error;
	}
	const format = (options.format ?? defaultFormatForCommand("crew-list")) as string;
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	return { command: "crew-list", format: format as CliFormat, full, ...(help ? { help: true } : {}) };
}

async function readDirectoryManifest(manifestPath: string, projectRoot: string): Promise<CrewManifest> {
	// Trust/layout checks happen before any manifest IO. The realpath check also
	// prevents a supported-looking manifest symlink from escaping the project.
	if (!isTrustedCrewManifestPath(manifestPath, projectRoot))
		throw new CrewManifestReadError("untrusted-path", "crew manifest is outside the supported project layout");
	let projectReal: string;
	let manifestReal: string;
	try {
		projectReal = await fs.realpath(projectRoot);
		manifestReal = await fs.realpath(manifestPath);
	} catch (error) {
		throw new CrewManifestReadError("read-failed", "crew manifest could not be resolved", { cause: error });
	}
	const relative = path.relative(projectReal, manifestReal);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		path.basename(manifestReal) !== "crew.json" ||
		!(["bebop", "crew"] as const).includes(path.basename(path.dirname(manifestReal)) as "bebop" | "crew")
	)
		throw new CrewManifestReadError(
			"untrusted-path",
			"crew manifest resolves outside the supported project layout",
		);
	let contents: string;
	try {
		contents = await fs.readFile(manifestReal, "utf8");
	} catch (error) {
		throw new CrewManifestReadError("read-failed", "crew manifest could not be read", { cause: error });
	}
	try {
		return parseCrewManifest(JSON.parse(contents), manifestReal);
	} catch (error) {
		if (error instanceof CrewManifestError) throw error;
		throw new CrewManifestReadError("invalid-json", "crew manifest contains invalid JSON", { cause: error });
	}
}

async function readLiveCrewRuntimes(
	projectRoot: string,
	signal?: AbortSignal,
): Promise<readonly CrewDirectoryLiveRuntime[]> {
	if (signal?.aborted) return [];
	const observedAt = new Date().toISOString();
	let sessions;
	try {
		sessions = await getLiveSessions(signal);
	} catch {
		return [];
	}
	const results = await Promise.all(
		sessions.map(async (session): Promise<CrewDirectoryLiveRuntime | undefined> => {
			if (signal?.aborted) return undefined;
			try {
				const { response } = await sendRpcCommand(
					session.socketPath,
					{ type: "status" },
					{ timeout: PROBE_TIMEOUT_MS, signal },
				);
				const statusData = response.data as
					| { status?: unknown; crewLocator?: unknown; projectTrusted?: unknown }
					| undefined;
				if (!response.success || statusData?.status !== "joined") return undefined;
				const data = statusData;
				if (
					typeof data.crewLocator !== "string" ||
					data.projectTrusted !== true ||
					!isTrustedCrewManifestPath(data.crewLocator, projectRoot)
				)
					return undefined;
				return { manifestPath: path.resolve(data.crewLocator), observedAt, availability: "online" };
			} catch {
				return undefined;
			}
		}),
	);
	return results.filter((row): row is CrewDirectoryLiveRuntime => row !== undefined);
}

export const defaultCrewListDependencies: CrewListDependencies = {
	manifestExists: async (manifestPath, projectRoot) => {
		if (!isTrustedCrewManifestPath(manifestPath, projectRoot)) return false;
		try {
			await fs.access(manifestPath);
			return true;
		} catch {
			return false;
		}
	},
	readManifest: readDirectoryManifest,
	probeMember: (socketPath, signal) => probeMemberEndpoint(socketPath, { timeoutMs: PROBE_TIMEOUT_MS, signal }),
	readObservedLocators: async () => [],
	readLiveRuntimes: readLiveCrewRuntimes,
	now: () => new Date(),
};

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
	deps: CrewListDependencies,
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

export async function runCrewListCommand(
	options: CrewListCliOptions,
	context: CliContext,
	deps: CrewListDependencies = defaultCrewListDependencies,
): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: crewListHelp() };
	const discovery = createDiscoveryWindow(context.signal);
	try {
		const projectRoot = path.resolve(context.cwd);
		const observedAt = deps.now().toISOString();
		const manifestPaths = getTrustedCrewManifestPaths(projectRoot).slice(0, MAX_CANDIDATES);
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
				// Invalid candidates are not Crews. Keep them in partial-discovery
				// evidence without fabricating a product row or exposing a Locator.
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
		const exposed = exposeAmbiguityRecovery(rows);
		const crews = options.full ? exposed : exposed.slice(0, MAX_OUTPUT_CREWS);
		const omitted = Math.max(0, exposed.length - crews.length);
		const termination = discovery.termination();
		const data = {
			crews,
			total: exposed.length,
			omitted,
			partial: invalidCandidates > 0 || omitted > 0 || termination !== undefined,
			...(termination === undefined ? {} : { discovery: termination }),
			...(invalidCandidates > 0 ? { invalidCandidates } : {}),
			...(crews.length === 0 ? { next: "initialize or join a trusted Crew, then rerun pi-bebop crew list" } : {}),
		};
		const result: CliResult = {
			ok: true,
			target: "",
			status:
				termination === undefined || (termination === "cancelled" && crews.length === 0)
					? crews.length === 0
						? "empty"
						: "listed"
					: "partial",
			data,
		};
		return { kind: "result", result, format: options.format, full: options.full };
	} finally {
		discovery.close();
	}
}
