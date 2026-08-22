import * as path from "node:path";
import {
	resolveCrewMemberBySocketPath,
	type CrewManifest,
	type CrewMember,
} from "../domain/index.ts";
import {
	claimMemberEndpoint,
	releaseMemberEndpoint,
	type MemberEndpointDependencies,
} from "./member-endpoint.ts";

export interface Membership {
	readonly manifestPath: string;
	readonly socketPath: string;
	readonly globalSocketPath: string;
	readonly member: CrewMember;
	readonly manifest: CrewManifest;
}

export type MembershipRuntimeErrorCode =
	| "manifest-load-failed"
	| "member-not-found"
	| "claim-failed"
	| "switch-release-failed"
	| "rollback-failed"
	| "leave-failed";

export class MembershipRuntimeError extends Error {
	readonly code: MembershipRuntimeErrorCode;
	readonly cause?: unknown;

	constructor(code: MembershipRuntimeErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "MembershipRuntimeError";
		this.code = code;
		this.cause = cause;
	}
}

export interface MembershipRuntimeDependencies {
	loadManifest: (manifestPath: string) => Promise<CrewManifest>;
	claimEndpoint?: typeof claimMemberEndpoint;
	releaseEndpoint?: typeof releaseMemberEndpoint;
	endpointDependencies?: MemberEndpointDependencies;
}

export interface JoinMembershipRequest {
	readonly manifestPath: string;
	readonly socketPath: string;
	readonly globalSocketPath: string;
}

export type MembershipFailure = { readonly ok: false; readonly error: MembershipRuntimeError };
export type JoinMembershipResult = { readonly ok: true; readonly membership: Membership; readonly idempotent: boolean } | MembershipFailure;
export type LeaveMembershipResult = { readonly ok: true; readonly left: boolean } | MembershipFailure;

export interface MembershipRuntime {
	join(request: JoinMembershipRequest): Promise<JoinMembershipResult>;
	leave(): Promise<LeaveMembershipResult>;
	getMembership(): Membership | null;
}

function failure(code: MembershipRuntimeErrorCode, message: string, cause?: unknown): { ok: false; error: MembershipRuntimeError } {
	return { ok: false, error: new MembershipRuntimeError(code, message, cause) };
}

export function createMembershipRuntime(dependencies: MembershipRuntimeDependencies): MembershipRuntime {
	const claim = dependencies.claimEndpoint ?? claimMemberEndpoint;
	const release = dependencies.releaseEndpoint ?? releaseMemberEndpoint;
	let membership: Membership | null = null;

	return {
		async join(request) {
			const manifestPath = path.resolve(request.manifestPath);
			const socketPath = path.resolve(request.socketPath);
			const globalSocketPath = path.resolve(request.globalSocketPath);

			let manifest: CrewManifest;
			try {
				manifest = await dependencies.loadManifest(manifestPath);
			} catch (error) {
				return failure("manifest-load-failed", `failed to load crew manifest: ${manifestPath}`, error);
			}

			let member: CrewMember;
			try {
				member = resolveCrewMemberBySocketPath(manifest, socketPath);
			} catch (error) {
				return failure("member-not-found", `no configured crew member matches: ${socketPath}`, error);
			}

			const sameEndpoint = membership?.socketPath === socketPath;
			let claimResult: Awaited<ReturnType<typeof claim>>;
			try {
				claimResult = await claim(socketPath, globalSocketPath, dependencies.endpointDependencies);
			} catch (error) {
				return failure("claim-failed", `failed to claim crew member endpoint: ${socketPath}`, error);
			}

			const nextMembership: Membership = { manifestPath, socketPath, globalSocketPath, member, manifest };
			if (sameEndpoint) {
				membership = nextMembership;
				return { ok: true, membership: nextMembership, idempotent: claimResult.idempotent };
			}
			if (!membership) {
				membership = nextMembership;
				return { ok: true, membership: nextMembership, idempotent: false };
			}

			const previousMembership = membership;
			try {
				await release(previousMembership.socketPath, previousMembership.globalSocketPath, dependencies.endpointDependencies);
			} catch (error) {
				try {
					await release(nextMembership.socketPath, nextMembership.globalSocketPath, dependencies.endpointDependencies);
				} catch (rollbackError) {
					return failure("rollback-failed", "failed to release old endpoint and roll back new endpoint", rollbackError);
				}
				return failure("switch-release-failed", "failed to release previous crew member endpoint", error);
			}

			membership = nextMembership;
			return { ok: true, membership: nextMembership, idempotent: false };
		},

		async leave() {
			if (!membership) return { ok: true, left: false };
			const current = membership;
			try {
				await release(current.socketPath, current.globalSocketPath, dependencies.endpointDependencies);
			} catch (error) {
				return failure("leave-failed", "failed to release crew member endpoint", error);
			}
			membership = null;
			return { ok: true, left: true };
		},

		getMembership() {
			return membership;
		},
	};
}
