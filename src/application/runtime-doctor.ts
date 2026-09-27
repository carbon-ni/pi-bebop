import type { CrewManifest } from "../domain/index.ts";
import {
	REQUIRED_RUNTIME_CAPABILITIES,
	isFullBuildCommit,
	isSemver,
	protocolVersionRelation,
	type RuntimeCompatibility,
} from "../domain/index.ts";

export const DEFAULT_DOCTOR_TIMEOUT_SECONDS = 2;
export const MIN_DOCTOR_TIMEOUT_SECONDS = 1;
export const MAX_DOCTOR_TIMEOUT_SECONDS = 30;

export type DoctorMemberStatus =
	| "compatible"
	| "unsupported-action"
	| "incompatible-runtime"
	| "stale-runtime"
	| "newer-runtime"
	| "missing-version"
	| "malformed-version"
	| "malformed-peer"
	| "offline"
	| "timeout"
	| "cancelled"
	| "transport-error";

export interface DoctorMemberResult {
	readonly name: string;
	readonly role: string;
	readonly status: DoctorMemberStatus;
	readonly message?: string;
	readonly next?: string;
	readonly packageVersion?: string;
	readonly protocol?: { readonly major: number; readonly minor: number };
	readonly missingCapabilities?: readonly string[];
	readonly buildCommit?: string;
	readonly capabilities?: readonly string[];
}

export interface DoctorCrewResult {
	readonly selector?: string;
	readonly displayName?: string;
	readonly status: "healthy" | "issues" | "configuration-error";
	readonly configuration: "healthy" | "invalid";
	readonly members: readonly DoctorMemberResult[];
	readonly message?: string;
	readonly next?: string;
}

export interface DoctorCliIdentity {
	readonly packageVersion: string;
	readonly buildCommit: string;
	readonly protocol: { readonly major: number; readonly minor: number };
}

export interface DoctorResult {
	readonly status: "healthy" | "issues" | "empty" | "cancelled";
	readonly cli: DoctorCliIdentity;
	readonly crews: readonly DoctorCrewResult[];
	readonly configuration: "healthy" | "issues";
	readonly partial: boolean;
}

export interface RuntimeDoctorDependencies {
	readonly discoverManifestPaths: (projectRoot: string) => readonly string[];
	readonly readManifest: (manifestPath: string, projectRoot: string) => Promise<CrewManifest>;
	readonly probeRuntime: (
		socketPath: string,
		options: { readonly timeoutMs: number; readonly signal: AbortSignal },
	) => Promise<RuntimeProbe>;
	readonly cli: DoctorCliIdentity;
}

export type RuntimeProbe =
	| { readonly kind: "response"; readonly value: unknown }
	| { readonly kind: "error"; readonly code: string; readonly message?: string };

export interface RuntimeDoctorRequest {
	readonly projectRoot: string;
	readonly timeoutSeconds: number;
	readonly diagnostic: boolean;
	readonly signal: AbortSignal;
}

function recovery(status: DoctorMemberStatus): string {
	switch (status) {
		case "incompatible-runtime":
		case "stale-runtime":
		case "newer-runtime":
			return "Update pi-bebop, restart the affected Member, then rerun `bebop doctor`.";
		case "unsupported-action":
			return "Update pi-bebop, restart the affected Member, then rerun `bebop doctor`.";
		case "offline":
			return "Start the affected Member, then rerun `bebop doctor`.";
		case "timeout":
			return "Retry with `bebop doctor --timeout 10`.";
		case "cancelled":
			return "Run `bebop doctor` again when ready.";
		case "malformed-peer":
		case "malformed-version":
		case "missing-version":
		case "transport-error":
			return "Restart the affected Member, then rerun `bebop doctor`.";
		default:
			return "Rerun `bebop doctor` to verify the Member.";
	}
}

function describe(status: DoctorMemberStatus): string {
	switch (status) {
		case "compatible":
			return "Runtime is compatible.";
		case "unsupported-action":
			return "A required Crew action is unavailable.";
		case "incompatible-runtime":
			return "The running Member does not support compatibility diagnosis.";
		case "stale-runtime":
			return "The running Member uses an older protocol.";
		case "newer-runtime":
			return "The running Member uses a newer protocol.";
		case "missing-version":
			return "The running Member did not report its version.";
		case "malformed-version":
			return "The running Member reported an invalid version.";
		case "malformed-peer":
			return "The running Member returned an invalid diagnostic response.";
		case "offline":
			return "The Member is offline.";
		case "timeout":
			return "The Member did not answer before the diagnostic deadline.";
		case "cancelled":
			return "The diagnostic was cancelled.";
		case "transport-error":
			return "The Member could not be reached.";
	}
}

function failure(
	name: string,
	role: string,
	status: Exclude<DoctorMemberStatus, "compatible">,
	extra: Partial<DoctorMemberResult> = {},
): DoctorMemberResult {
	return {
		name,
		role,
		status,
		message: describe(status),
		next: recovery(status),
		...extra,
	};
}

function classifyError(error: RuntimeProbe & { kind: "error" }): Exclude<DoctorMemberResult["status"], "compatible"> {
	if (error.code === "method-not-found") return "incompatible-runtime";
	if (error.code === "timeout") return "timeout";
	if (error.code === "aborted" || error.code === "AbortError") return "cancelled";
	if (error.code === "malformed-response" || error.code === "invalid-result" || error.code === "mismatched-id")
		return "malformed-peer";
	if (["ENOENT", "ECONNREFUSED", "ENOTCONN", "offline"].includes(error.code)) return "offline";
	return "transport-error";
}

function inspectCompatibility(name: string, role: string, value: unknown): DoctorMemberResult {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return failure(name, role, "malformed-peer");
	const candidate = value as Partial<RuntimeCompatibility> & { protocol?: unknown };
	if (candidate.product !== "pi-bebop") return failure(name, role, "malformed-peer");
	if (
		candidate.packageVersion === undefined ||
		candidate.buildCommit === undefined ||
		candidate.protocol === undefined
	)
		return failure(name, role, "missing-version");
	if (!isSemver(candidate.packageVersion) || !isFullBuildCommit(candidate.buildCommit))
		return failure(name, role, "malformed-version");
	if (
		candidate.protocol === null ||
		typeof candidate.protocol !== "object" ||
		(candidate.protocol as { name?: unknown }).name !== "pi-bebop" ||
		typeof candidate.protocol.major !== "number" ||
		typeof candidate.protocol.minor !== "number" ||
		!Number.isInteger(candidate.protocol.major) ||
		!Number.isInteger(candidate.protocol.minor) ||
		candidate.protocol.major < 0 ||
		candidate.protocol.minor < 0
	)
		return failure(name, role, "malformed-version");
	if (!Array.isArray(candidate.capabilities) || candidate.capabilities.some((item) => typeof item !== "string"))
		return failure(name, role, "malformed-peer");
	const protocol = { major: candidate.protocol.major, minor: candidate.protocol.minor };
	const common = {
		packageVersion: candidate.packageVersion,
		protocol,
		buildCommit: candidate.buildCommit,
		capabilities: [...candidate.capabilities],
	};
	const relation = protocolVersionRelation(protocol);
	if (relation === "older") return failure(name, role, "stale-runtime", common);
	if (relation === "newer") return failure(name, role, "newer-runtime", common);
	const missing = REQUIRED_RUNTIME_CAPABILITIES.filter((required) => !candidate.capabilities!.includes(required));
	if (missing.length > 0)
		return failure(name, role, "unsupported-action", { ...common, missingCapabilities: missing });
	return { name, role, status: "compatible", ...common };
}

function sanitizeDiagnostic(member: DoctorMemberResult, diagnostic: boolean): DoctorMemberResult {
	if (diagnostic) return member;
	const {
		buildCommit: _buildCommit,
		capabilities: _capabilities,
		missingCapabilities: _missingCapabilities,
		...safe
	} = member;
	return safe;
}

/** Bounded, read-only diagnosis. All Members are inspected independently. */
export async function diagnoseRuntimeCompatibility(
	request: RuntimeDoctorRequest,
	deps: RuntimeDoctorDependencies,
): Promise<DoctorResult> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(request.signal.reason);
	if (request.signal.aborted) controller.abort(request.signal.reason);
	else request.signal.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => controller.abort(new Error("doctor timeout")), request.timeoutSeconds * 1000);
	const crews: DoctorCrewResult[] = [];
	let partial = false;
	try {
		for (const manifestPath of deps.discoverManifestPaths(request.projectRoot)) {
			if (controller.signal.aborted) {
				partial = true;
				break;
			}
			let manifest: CrewManifest;
			try {
				manifest = await deps.readManifest(manifestPath, request.projectRoot);
			} catch {
				partial = true;
				crews.push({
					status: "configuration-error",
					configuration: "invalid",
					members: [],
					message: "Crew configuration is invalid or unavailable.",
					next: "Fix the trusted Crew configuration, then rerun `bebop doctor`.",
				});
				continue;
			}
			const members = await Promise.all(
				manifest.members.map(async (member) => {
					if (controller.signal.aborted) return failure(member.name, member.role, "cancelled");
					const probe = await deps.probeRuntime(member.socketPath, {
						timeoutMs: request.timeoutSeconds * 1000,
						signal: controller.signal,
					});
					if (probe.kind === "error") {
						const status = classifyError(probe);
						return failure(member.name, member.role, status);
					}
					return inspectCompatibility(member.name, member.role, probe.value);
				}),
			);
			const safeMembers = members.map((member) => sanitizeDiagnostic(member, request.diagnostic));
			const hasIssues = safeMembers.some((member) => member.status !== "compatible");
			partial ||= hasIssues;
			crews.push({
				...(manifest.crew === undefined
					? {}
					: { selector: manifest.crew.id, displayName: manifest.crew.displayName }),
				status: hasIssues ? "issues" : "healthy",
				configuration: "healthy",
				members: safeMembers,
			});
		}
		const status = controller.signal.aborted
			? request.signal.aborted
				? "cancelled"
				: "issues"
			: crews.length === 0
				? "empty"
				: partial
					? "issues"
					: "healthy";
		return {
			status,
			cli: deps.cli,
			crews,
			configuration: crews.some((crew) => crew.configuration === "invalid") ? "issues" : "healthy",
			partial,
		};
	} finally {
		clearTimeout(timeout);
		request.signal.removeEventListener("abort", onAbort);
	}
}
