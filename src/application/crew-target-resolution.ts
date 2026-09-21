import { realpathSync } from "node:fs";
import * as path from "node:path";
import { isStatusResult, type CrewManifest, type CrewMember } from "../domain/index.ts";
import { sendRpcCommand, RpcProtocolError } from "../infra/rpc-client.ts";
import { getTrustedCrewManifestPaths, isTrustedCrewManifestPath } from "../infra/crew-layout.ts";
import { readTrustedCrewManifestMetadata } from "../infra/crew-manifest-store.ts";

/** The product-facing target grammar. The selector is exact and case-sensitive. */
export interface CrewTarget {
	readonly selector: string;
	readonly member?: string;
}

export type CrewRouteCaller =
	| {
			readonly kind: "member";
			readonly crewSelector: string;
			readonly crewLocator: string;
			readonly memberName: string;
			readonly role: string;
			readonly trusted: boolean;
	  }
	| {
			readonly kind: "guest";
			readonly crewSelector: string;
			readonly crewLocator: string;
			readonly guestIdentity: string;
			readonly guestName: string;
			readonly approved: boolean;
			readonly capabilities: readonly string[];
	  }
	| { readonly kind: "external" };

export type CrewRouteAction = "member-request" | "follow-up" | "broadcast";

export interface CrewRouteResolutionRequest {
	readonly target: string | CrewTarget;
	readonly projectRoot: string;
	readonly caller: CrewRouteCaller;
	readonly locator?: string;
	readonly action?: CrewRouteAction;
	readonly signal?: AbortSignal;
}

export interface CrewRouteTarget {
	readonly crew: { readonly selector: string; readonly displayName: string };
	readonly member: { readonly name: string; readonly role: string };
}

/** Internal transport route. Do not serialize this object as product output. */
export interface ResolvedCrewRoute {
	readonly target: CrewRouteTarget;
	readonly caller: { readonly kind: "member" | "guest"; readonly identity: string };
	readonly endpoint: string;
	readonly locator: string;
}

export type CrewRouteResolutionErrorCode =
	| "unknown-crew"
	| "unknown-member"
	| "ambiguous-crew"
	| "invalid-manifest"
	| "authorization-required"
	| "offline-crew"
	| "offline-member"
	| "route-conflict"
	| "route-lost"
	| "discovery-timeout"
	| "cancelled"
	| "self-target"
	| "malformed-response";

export type CrewRouteResolutionStage = "resolution" | "discovery" | "delivery";

export class CrewRouteResolutionError extends Error {
	readonly code: CrewRouteResolutionErrorCode;
	readonly stage: CrewRouteResolutionStage;
	readonly target: string;
	readonly recovery: string;
	readonly safeRetry: boolean;
	readonly candidateLocators?: readonly string[];
	readonly totalCandidates?: number;
	readonly shownCandidates?: number;
	readonly truncatedCandidates?: boolean;

	constructor(
		code: CrewRouteResolutionErrorCode,
		message: string,
		options: {
			stage?: CrewRouteResolutionStage;
			target: string;
			recovery: string;
			safeRetry?: boolean;
			candidateLocators?: readonly string[];
			totalCandidates?: number;
			shownCandidates?: number;
			truncatedCandidates?: boolean;
		},
	) {
		super(message);
		this.name = "CrewRouteResolutionError";
		this.code = code;
		this.stage = options.stage ?? "resolution";
		this.target = options.target;
		this.recovery = options.recovery;
		this.safeRetry = options.safeRetry ?? true;
		this.candidateLocators = options.candidateLocators;
		this.totalCandidates = options.totalCandidates;
		this.shownCandidates = options.shownCandidates;
		this.truncatedCandidates = options.truncatedCandidates;
	}
}

export interface CrewRouteLocatorCandidate {
	readonly locator: string;
	readonly availability?: "online" | "offline" | "unknown";
}

export type CanonicalOwnerObservation =
	| {
			readonly state: "online";
			readonly owner: { readonly selector: string; readonly member: string; readonly locator: string };
	  }
	| { readonly state: "offline" }
	| { readonly state: "conflict" }
	| { readonly state: "malformed" };

export interface CrewRouteResolutionDependencies {
	readonly isProjectTrusted: () => boolean;
	readonly isTrustedManifestPath?: (manifestPath: string, projectRoot: string) => boolean;
	readonly discoverLocators: (
		projectRoot: string,
		signal?: AbortSignal,
	) => Promise<readonly CrewRouteLocatorCandidate[]>;
	readonly realpath: (locator: string, signal?: AbortSignal) => Promise<string>;
	readonly readManifest: (locator: string, projectRoot: string, signal?: AbortSignal) => Promise<CrewManifest>;
	readonly probeCanonicalOwner: (
		endpoint: string,
		expected: { readonly selector: string; readonly member: string; readonly locator: string },
		signal?: AbortSignal,
	) => Promise<CanonicalOwnerObservation>;
	/** Re-checks the canonical endpoint after discovery/probe to close the route race window. */
	readonly revalidateRoute?: (
		endpoint: string,
		expected: { readonly selector: string; readonly member: string; readonly locator: string },
		signal?: AbortSignal,
	) => Promise<boolean>;
}

export const CREW_ROUTE_DISCOVERY_TIMEOUT_MS = 2_000;
export const CREW_ROUTE_PROBE_TIMEOUT_MS = 300;
export const MAX_AMBIGUOUS_LOCATORS = 20;
const SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TARGET_BYTES = 256;

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

async function probeCanonicalOwner(
	endpoint: string,
	expected: { readonly selector: string; readonly member: string; readonly locator: string },
	signal?: AbortSignal,
): Promise<CanonicalOwnerObservation> {
	throwIfAborted(signal);
	try {
		const { response } = await sendRpcCommand(
			endpoint,
			{ type: "status" },
			{ timeout: CREW_ROUTE_PROBE_TIMEOUT_MS, signal },
		);
		throwIfAborted(signal);
		if (!response.success || !isStatusResult(response.data)) return { state: "malformed" };
		if (response.data.status === "stopped") return { state: "offline" };
		if (response.data.projectTrusted !== true || !response.data.crewLocator) return { state: "conflict" };
		if (!sameCanonicalPath(response.data.crewLocator, expected.locator)) return { state: "conflict" };
		return { state: "online", owner: expected };
	} catch (error) {
		throwIfAborted(signal);
		if (error instanceof RpcProtocolError && ["malformed-response", "invalid-result"].includes(error.code))
			return { state: "malformed" };
		return { state: "offline" };
	}
}

function isTrustedCanonicalManifestPath(manifestPath: string, projectRoot: string): boolean {
	if (isTrustedCrewManifestPath(manifestPath, projectRoot)) return true;
	try {
		return getTrustedCrewManifestPaths(realpathSync(projectRoot)).includes(path.resolve(manifestPath));
	} catch {
		return false;
	}
}

function sameCanonicalPath(left: string, right: string): boolean {
	if (path.resolve(left) === path.resolve(right)) return true;
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false;
	}
}

function lexicalTrustedManifestPath(manifestPath: string, projectRoot: string): string {
	if (isTrustedCrewManifestPath(manifestPath, projectRoot)) return manifestPath;
	try {
		const canonical = path.resolve(manifestPath);
		return (
			getTrustedCrewManifestPaths(projectRoot).find((candidate) => realpathSync(candidate) === canonical) ??
			manifestPath
		);
	} catch {
		return manifestPath;
	}
}

export function createCrewRouteResolutionDependencies(
	isProjectTrusted: () => boolean = () => false,
): CrewRouteResolutionDependencies {
	return {
		isProjectTrusted,
		isTrustedManifestPath: isTrustedCanonicalManifestPath,
		discoverLocators: async (projectRoot) =>
			getTrustedCrewManifestPaths(projectRoot).map((locator) => ({ locator, availability: "unknown" as const })),
		realpath: async (locator, signal) => {
			throwIfAborted(signal);
			const resolved = await (await import("node:fs/promises")).realpath(locator);
			throwIfAborted(signal);
			return resolved;
		},
		readManifest: async (locator, projectRoot, signal) => {
			throwIfAborted(signal);
			const manifest = await readTrustedCrewManifestMetadata(
				lexicalTrustedManifestPath(locator, projectRoot),
				projectRoot,
				isProjectTrusted,
			);
			throwIfAborted(signal);
			return manifest;
		},
		probeCanonicalOwner,
	};
}

export function createCrewTargetResolver(
	dependencies: Partial<CrewRouteResolutionDependencies> = {},
): (request: CrewRouteResolutionRequest) => Promise<ResolvedCrewRoute> {
	const resolvedDependencies = {
		...createCrewRouteResolutionDependencies(dependencies.isProjectTrusted),
		...dependencies,
	};
	return (request) => resolveCrewTarget(request, resolvedDependencies);
}

function targetLabel(target: CrewTarget): string {
	return target.member === undefined ? target.selector : `${target.selector}/${target.member}`;
}

function productTarget(target: CrewTarget): string {
	return targetLabel(target);
}

function invalidTargetError(
	recovery = "Run `bebop crew list` and use an exact Crew selector.",
): CrewRouteResolutionError {
	return new CrewRouteResolutionError("unknown-crew", "Invalid Crew target", {
		target: "<invalid-target>",
		recovery,
	});
}

export function parseCrewTarget(input: string | CrewTarget): CrewTarget {
	if (typeof input !== "string") {
		if (!SELECTOR_PATTERN.test(input.selector) || input.member === "" || input.member?.includes("/"))
			throw invalidTargetError();
		return { selector: input.selector, ...(input.member === undefined ? {} : { member: input.member }) };
	}
	if (Buffer.byteLength(input, "utf8") > MAX_TARGET_BYTES || input !== input.trim() || input.length === 0) {
		throw invalidTargetError();
	}
	const slash = input.indexOf("/");
	const selector = slash < 0 ? input : input.slice(0, slash);
	const member = slash < 0 ? undefined : input.slice(slash + 1);
	if (!SELECTOR_PATTERN.test(selector) || member === "") throw invalidTargetError();
	return { selector, ...(member === undefined ? {} : { member }) };
}

function resolutionError(
	code: CrewRouteResolutionErrorCode,
	target: CrewTarget,
	message: string,
	recovery: string,
	options: Partial<ConstructorParameters<typeof CrewRouteResolutionError>[2]> = {},
): CrewRouteResolutionError {
	return new CrewRouteResolutionError(code, message, { target: productTarget(target), recovery, ...options });
}

function abortError(target: CrewTarget): CrewRouteResolutionError {
	return resolutionError(
		"cancelled",
		target,
		`Routing '${productTarget(target)}' was cancelled`,
		"Retry the same command.",
		{
			stage: "discovery",
		},
	);
}

/** Bounds the complete discovery phase, including canonicalization and manifest reads. */
async function withDiscoveryDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	target: CrewTarget,
	parentSignal: AbortSignal,
): Promise<T> {
	if (parentSignal.aborted) throw abortError(target);
	const controller = new AbortController();
	const onParentAbort = () => controller.abort(parentSignal.reason);
	parentSignal.addEventListener("abort", onParentAbort, { once: true });
	return await new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			parentSignal.removeEventListener("abort", onParentAbort);
			parentSignal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => {
			controller.abort(parentSignal.reason);
			finish(() => reject(abortError(target)));
		};
		parentSignal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => {
			controller.abort(new Error("Crew discovery timeout"));
			finish(() =>
				reject(
					resolutionError(
						"discovery-timeout",
						target,
						`Crew discovery timed out while resolving '${productTarget(target)}'`,
						`Retry: \`bebop ask ${productTarget(target)} ...\``,
						{ stage: "discovery" },
					),
				),
			);
		}, CREW_ROUTE_DISCOVERY_TIMEOUT_MS);
		void Promise.resolve()
			.then(() => {
				if (controller.signal.aborted) throw abortError(target);
				return operation(controller.signal);
			})
			.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
	});
}

/** Bounds the canonical owner probe and aborts the underlying transport operation. */
async function withProbeDeadline(
	operation: (signal: AbortSignal) => Promise<CanonicalOwnerObservation>,
	target: CrewTarget,
	parentSignal: AbortSignal,
): Promise<CanonicalOwnerObservation> {
	if (parentSignal.aborted) throw abortError(target);
	const controller = new AbortController();
	const onAbort = () => controller.abort(parentSignal.reason);
	parentSignal.addEventListener("abort", onAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			Promise.resolve().then(() => {
				if (controller.signal.aborted) throw abortError(target);
				return operation(controller.signal);
			}),
			new Promise<CanonicalOwnerObservation>((resolve) => {
				timer = setTimeout(() => {
					controller.abort(new Error("canonical route probe timeout"));
					resolve({ state: "offline" });
				}, CREW_ROUTE_PROBE_TIMEOUT_MS);
			}),
		]);
		if (parentSignal.aborted) throw abortError(target);
		return result;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		parentSignal.removeEventListener("abort", onAbort);
		controller.abort();
	}
}

/** Bounds the post-probe route revalidation used to close mutation races. */
async function withRevalidationDeadline(
	operation: (signal: AbortSignal) => Promise<boolean>,
	target: CrewTarget,
	parentSignal: AbortSignal,
): Promise<boolean> {
	if (parentSignal.aborted) throw abortError(target);
	const controller = new AbortController();
	const onAbort = () => controller.abort(parentSignal.reason);
	parentSignal.addEventListener("abort", onAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			Promise.resolve().then(() => {
				if (controller.signal.aborted) throw abortError(target);
				return operation(controller.signal);
			}),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => {
					controller.abort(new Error("route revalidation timeout"));
					resolve(false);
				}, CREW_ROUTE_PROBE_TIMEOUT_MS);
			}),
		]);
		if (parentSignal.aborted) throw abortError(target);
		return result;
	} catch {
		if (parentSignal.aborted) throw abortError(target);
		return false;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		parentSignal.removeEventListener("abort", onAbort);
		controller.abort();
	}
}

function hasTraversal(locator: string): boolean {
	return locator.split(/[\\/]+/).includes("..");
}

export function compareStable(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalCandidates(locators: readonly string[], projectRoot: string): string[] {
	return [
		...new Set(
			locators.filter((locator) => !hasTraversal(locator)).map((locator) => path.resolve(projectRoot, locator)),
		),
	].sort(compareStable);
}

function validateCaller(
	request: CrewRouteResolutionRequest,
	target: CrewTarget,
): Extract<CrewRouteCaller, { kind: "member" | "guest" }> {
	const caller = request.caller;
	if (caller.kind === "external")
		throw resolutionError(
			"authorization-required",
			target,
			`An authorized Member or approved Guest route is required for '${productTarget(target)}'`,
			"Join the Crew as the intended Member or establish an approved Guest membership.",
		);
	if (caller.kind === "member" && (!caller.trusted || !caller.crewLocator))
		throw resolutionError(
			"authorization-required",
			target,
			`The current Member route is not trusted for '${productTarget(target)}'`,
			"Run the command from a trusted joined Crew Member session.",
		);
	if (caller.kind === "guest" && (!caller.approved || !caller.crewLocator))
		throw resolutionError(
			"authorization-required",
			target,
			`The Guest route is not approved for '${productTarget(target)}'`,
			"Establish an approved Guest membership for the exact Crew.",
		);
	if (caller.crewSelector !== target.selector)
		throw resolutionError(
			"authorization-required",
			target,
			`The current route is not authorized for Crew '${target.selector}'`,
			"Use the exact Crew membership that owns this target.",
		);
	const requiredCapability = request.action ?? "member-request";
	if (caller.kind === "guest" && !(caller.capabilities as readonly string[]).includes(requiredCapability))
		throw resolutionError(
			"authorization-required",
			target,
			`The approved Guest route cannot perform this action for '${productTarget(target)}'`,
			"Use a Guest membership with the required action capability.",
		);
	return caller;
}

function findTargetMember(manifest: CrewManifest, target: CrewTarget): CrewMember {
	const names = new Set<string>();
	for (const member of manifest.members) {
		if (names.has(member.name))
			throw resolutionError(
				"invalid-manifest",
				target,
				`Crew '${target.selector}' has duplicate Member name '${member.name}'`,
				"Repair the manifest; duplicate Member names are not routable.",
			);
		names.add(member.name);
	}
	const matching =
		target.member === undefined ? [] : manifest.members.filter((member) => member.name === target.member);
	if (target.member !== undefined && matching.length > 1)
		throw resolutionError(
			"invalid-manifest",
			target,
			`Crew '${target.selector}' has duplicate Member name '${target.member}'`,
			"Repair the manifest; duplicate Member names are not routable.",
		);
	if (target.member !== undefined && matching.length === 0)
		throw resolutionError(
			"unknown-member",
			target,
			`Unknown Member '${target.member}' in Crew '${target.selector}'`,
			`Use an exact Member target from \`bebop crew list\` or target one of the configured names.`,
		);
	if (target.member !== undefined) return matching[0]!;
	const contact = manifest.intake?.contact;
	if (!contact)
		throw resolutionError(
			"unknown-member",
			target,
			`Crew '${target.selector}' has no manifest-authored Crew contact`,
			`Use an exact Member target: \`bebop ask ${target.selector}/<member> ...\``,
		);
	const contacts = manifest.members.filter((member) => member.name === contact);
	if (contacts.length !== 1)
		throw resolutionError(
			"invalid-manifest",
			target,
			`Crew '${target.selector}' has an invalid manifest-authored contact`,
			"Repair the manifest; the Crew contact must name exactly one configured Member.",
		);
	return contacts[0]!;
}

export async function resolveCrewTarget(
	request: CrewRouteResolutionRequest,
	dependencies: Partial<CrewRouteResolutionDependencies> = {},
): Promise<ResolvedCrewRoute> {
	const deps = {
		...createCrewRouteResolutionDependencies(dependencies.isProjectTrusted),
		...dependencies,
	};
	const target = parseCrewTarget(request.target);
	const caller = validateCaller(request, target);
	const signal = request.signal ?? new AbortController().signal;
	if (signal.aborted) throw abortError(target);
	if (!deps.isProjectTrusted())
		throw resolutionError(
			"authorization-required",
			target,
			`Project trust is required before routing '${productTarget(target)}'`,
			"Run the command from a trusted joined Crew Member session.",
		);
	if (!isTrustedCrewManifestPath(caller.crewLocator, request.projectRoot))
		throw resolutionError(
			"authorization-required",
			target,
			`The current route is outside the trusted project for '${productTarget(target)}'`,
			"Use the current joined Member or approved Guest route for this Crew.",
		);

	if (request.locator && hasTraversal(request.locator))
		throw resolutionError(
			"authorization-required",
			target,
			`Crew Locator is outside the trusted project for '${productTarget(target)}'`,
			"Use the canonical trusted Crew Locator from the current project.",
		);
	const resolution = await withDiscoveryDeadline(
		async (discoverySignal) => {
			let canonicalCallerLocator: string;
			try {
				canonicalCallerLocator = await deps.realpath(caller.crewLocator, discoverySignal);
			} catch {
				if (discoverySignal.aborted) throw abortError(target);
				throw resolutionError(
					"authorization-required",
					target,
					`The current route does not own Crew '${target.selector}'`,
					"Use the current joined Member or approved Guest route for this Crew.",
				);
			}
			const discovered = request.locator
				? [{ locator: request.locator }]
				: await deps.discoverLocators(request.projectRoot, discoverySignal);
			const candidateInputs = request.locator ? discovered : [...discovered, { locator: caller.crewLocator }];
			const availabilityByLocator = new Map<string, CrewRouteLocatorCandidate["availability"]>();
			for (const candidate of candidateInputs) {
				const locator = path.resolve(candidate.locator);
				if (candidate.availability !== undefined || !availabilityByLocator.has(locator))
					availabilityByLocator.set(locator, candidate.availability);
			}
			const candidates = canonicalCandidates(
				candidateInputs.map((candidate) => candidate.locator),
				request.projectRoot,
			);
			const isTrustedManifestPath = deps.isTrustedManifestPath ?? isTrustedCrewManifestPath;
			const trustedCandidates = candidates.filter((locator) =>
				isTrustedManifestPath(locator, request.projectRoot),
			);
			if (trustedCandidates.length === 0)
				throw resolutionError(
					request.locator ? "authorization-required" : "unknown-crew",
					target,
					request.locator
						? `Crew Locator is outside the trusted project for '${productTarget(target)}'`
						: `Unknown Crew '${target.selector}'`,
					request.locator
						? "Use the canonical trusted Crew Locator from the current project."
						: "Run `bebop crew list` and use an exact Crew selector.",
				);

			const matching: Array<{
				locator: string;
				manifest: CrewManifest;
				availability?: CrewRouteLocatorCandidate["availability"];
			}> = [];
			const canonicalSeen = new Set<string>();
			let invalidCount = 0;
			let escapedCount = 0;
			for (const locator of trustedCandidates) {
				if (discoverySignal.aborted) throw abortError(target);
				let canonical: string;
				try {
					canonical = await deps.realpath(locator, discoverySignal);
				} catch {
					if (discoverySignal.aborted) throw abortError(target);
					continue;
				}
				if (discoverySignal.aborted) throw abortError(target);
				if (canonicalSeen.has(canonical)) continue;
				canonicalSeen.add(canonical);
				if (!isTrustedManifestPath(canonical, request.projectRoot)) {
					escapedCount += 1;
					continue;
				}
				try {
					const manifest = await deps.readManifest(canonical, request.projectRoot, discoverySignal);
					if (manifest.crew?.id === target.selector)
						matching.push({
							locator: canonical,
							manifest,
							availability: availabilityByLocator.get(locator),
						});
				} catch {
					if (discoverySignal.aborted) throw abortError(target);
					invalidCount += 1;
				}
			}
			if (matching.length === 0) {
				if (request.locator && escapedCount > 0)
					throw resolutionError(
						"authorization-required",
						target,
						`Crew Locator is outside the trusted project for '${productTarget(target)}'`,
						"Use the canonical trusted Crew Locator from the current project.",
					);
				if (invalidCount > 0)
					throw resolutionError(
						"invalid-manifest",
						target,
						`Crew '${target.selector}' could not be read from a valid manifest`,
						"Repair the trusted Crew manifest and retry.",
					);
				throw resolutionError(
					"unknown-crew",
					target,
					`Unknown Crew '${target.selector}'`,
					"Run `bebop crew list` and use an exact Crew selector.",
				);
			}
			return { matching, canonicalCallerLocator };
		},
		target,
		signal,
	);
	const { matching, canonicalCallerLocator } = resolution;
	if (!request.locator && matching.length > 1) {
		const shown = matching.map(({ locator }) => locator).slice(0, MAX_AMBIGUOUS_LOCATORS);
		throw resolutionError(
			"ambiguous-crew",
			target,
			`Crew selector '${target.selector}' matches multiple trusted Crews`,
			`Retry with an explicit \`--crew <locator>\` for '${target.selector}'.`,
			{
				candidateLocators: shown,
				totalCandidates: matching.length,
				shownCandidates: shown.length,
				truncatedCandidates: matching.length > shown.length,
			},
		);
	}
	const selected = matching[0]!;
	if (selected.availability === "offline")
		throw resolutionError(
			"offline-crew",
			target,
			`Crew '${target.selector}' is offline`,
			"Retry later; no delivery was attempted.",
		);
	if (selected.locator !== canonicalCallerLocator)
		throw resolutionError(
			"authorization-required",
			target,
			`The current route does not own Crew '${target.selector}'`,
			"Use the current joined Member or approved Guest route for this Crew.",
		);
	const member = findTargetMember(selected.manifest, target);
	if (caller.kind === "member" && member.name === caller.memberName)
		throw resolutionError(
			"self-target",
			target,
			`Member '${member.name}' cannot target itself`,
			`Choose another exact Member in Crew '${target.selector}'.`,
		);
	const expected = { selector: target.selector, member: member.name, locator: selected.locator } as const;
	if (signal.aborted) throw abortError(target);
	let owner: CanonicalOwnerObservation;
	try {
		owner = await withProbeDeadline(
			(probeSignal) => deps.probeCanonicalOwner(member.socketPath, expected, probeSignal),
			target,
			signal,
		);
	} catch {
		owner = { state: "malformed" };
	}
	if (signal.aborted) throw abortError(target);
	if (owner.state === "offline")
		throw resolutionError(
			"offline-member",
			target,
			`Member '${member.name}' in Crew '${target.selector}' is offline`,
			"Retry later; no delivery was attempted.",
		);
	if (owner.state === "conflict")
		throw resolutionError(
			"route-conflict",
			target,
			`The canonical route for '${productTarget(target)}' has conflicting ownership`,
			"Do not guess a runtime; repair the Crew endpoint and retry.",
			{ safeRetry: false },
		);
	if (owner.state === "malformed")
		throw resolutionError(
			"malformed-response",
			target,
			`The canonical route for '${productTarget(target)}' returned malformed peer state`,
			"Run `bebop doctor` and retry after repairing the peer.",
		);
	if (
		owner.owner.selector !== expected.selector ||
		owner.owner.member !== expected.member ||
		path.resolve(owner.owner.locator) !== path.resolve(expected.locator)
	)
		throw resolutionError(
			"route-conflict",
			target,
			`The canonical route owner does not match '${productTarget(target)}'`,
			"Do not guess a runtime; repair the Crew endpoint and retry.",
			{ safeRetry: false },
		);
	if (
		deps.revalidateRoute &&
		!(await withRevalidationDeadline(
			(revalidateSignal) => deps.revalidateRoute!(member.socketPath, expected, revalidateSignal),
			target,
			signal,
		))
	)
		throw resolutionError(
			"route-lost",
			target,
			`The canonical route for '${productTarget(target)}' changed during resolution`,
			"Retry the exact command; no alternate runtime was selected.",
		);
	return {
		target: {
			crew: { selector: target.selector, displayName: selected.manifest.crew!.displayName },
			member: { name: member.name, role: member.role },
		},
		caller: { kind: caller.kind, identity: caller.kind === "member" ? caller.memberName : caller.guestName },
		endpoint: member.socketPath,
		locator: selected.locator,
	};
}

/** Safe product projection for CLI/text/TOON/JSON output. */
export function publicCrewRoute(route: ResolvedCrewRoute): {
	readonly target: CrewRouteTarget;
	readonly caller: ResolvedCrewRoute["caller"];
} {
	return { target: route.target, caller: route.caller };
}

export interface PublicCrewRouteError {
	readonly code: CrewRouteResolutionErrorCode;
	readonly stage: CrewRouteResolutionStage;
	readonly target: string;
	readonly recovery: string;
	readonly safeRetry: boolean;
	readonly candidateLocators?: readonly string[];
	readonly totalCandidates?: number;
	readonly shownCandidates?: number;
	readonly truncatedCandidates?: boolean;
}

/** Safe product projection for CLI/text/TOON/JSON error output. */
export function publicCrewRouteError(error: CrewRouteResolutionError): PublicCrewRouteError {
	return {
		code: error.code,
		stage: error.stage,
		target: error.target,
		recovery: error.recovery,
		safeRetry: error.safeRetry,
		...(error.candidateLocators === undefined ? {} : { candidateLocators: error.candidateLocators }),
		...(error.totalCandidates === undefined ? {} : { totalCandidates: error.totalCandidates }),
		...(error.shownCandidates === undefined ? {} : { shownCandidates: error.shownCandidates }),
		...(error.truncatedCandidates === undefined ? {} : { truncatedCandidates: error.truncatedCandidates }),
	};
}
