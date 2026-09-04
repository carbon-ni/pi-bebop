import {
	bindGuestApprovalCapability,
	crewSelectorFromConfig,
	guestAdmissionPolicy,
	isGuestRegistryCapabilityDigest,
	isGuestApproval,
	isGuestJoinRequest,
	isGuestMembershipRecord,
	type CrewManifest,
	type CrewSelector,
	type GuestApproval,
	type GuestApprovalCapability,
	type GuestJoinRequest,
	type GuestMembershipRecord,
} from "../domain/index.ts";

export type GuestAdmissionState = "pending" | "approved" | "denied" | "revoked";

export interface GuestAdmissionView {
	readonly status: GuestAdmissionState;
	readonly requestId?: string;
	readonly crew: CrewSelector;
	readonly guestIdentity: string;
	readonly guestName: string;
	readonly approvedBy?: string;
}

export type GuestAdmissionJoinResult =
	| {
			readonly ok: true;
			readonly status: "pending" | "approved";
			readonly requestId: string;
			readonly crew: CrewSelector;
			readonly idempotent: boolean;
	  }
	| {
			readonly ok: false;
			readonly code:
				| "guest-disabled"
				| "invalid-request"
				| "crew-mismatch"
				| "name-collision"
				| "revoked"
				| "denied"
				| "join-failed";
	  };

export type GuestAdmissionApprovalResult =
	| {
			readonly ok: true;
			readonly record: GuestMembershipRecord;
			readonly capability: GuestApprovalCapability;
			readonly idempotent: boolean;
	  }
	| { readonly ok: false; readonly code: "unauthorized" | "not-found" | "approval-mismatch" | "approval-failed" };

export type GuestAdmissionMutationResult =
	| { readonly ok: true; readonly changed: boolean }
	| { readonly ok: false; readonly code: "unauthorized" | "not-found" | "mutation-failed" };

export type GuestAdmissionPersistedRecord =
	| {
			readonly status: "approved";
			readonly record: GuestMembershipRecord;
			/** Verifier digest of the runtime-held capability; never plaintext. */
			readonly capabilityDigest?: string;
	  }
	| { readonly status: "revoked"; readonly record: GuestMembershipRecord }
	| { readonly status: "denied"; readonly request: GuestJoinRequest; readonly approver?: string };

export interface GuestAdmissionRuntime {
	receive(request: GuestJoinRequest): GuestAdmissionJoinResult;
	approve(requestId: string, approver: string, capability?: string): GuestAdmissionApprovalResult;
	deny(requestId: string, approver: string): GuestAdmissionMutationResult;
	remove(guestName: string, approver: string): GuestAdmissionMutationResult;
	revoke(guestIdentity: string, crewId: string, callbackEndpoint: string): GuestAdmissionMutationResult;
	list(): readonly GuestAdmissionView[];
	restore(records: readonly unknown[]): {
		readonly restored: readonly string[];
		readonly rejected: readonly string[];
	};
}

export interface GuestAdmissionRuntimeDependencies {
	readonly manifest: Pick<CrewManifest, "crew" | "guestAdmission" | "members">;
	readonly memberName: string;
	readonly createRequestId: () => string;
	readonly createCapability?: () => string;
	/** Verifier-digest derivation for registry persistence; plaintext never persists. */
	readonly digestCapability?: (capability: string) => string;
	readonly persist?: (records: readonly GuestAdmissionPersistedRecord[]) => void;
}

interface PendingEntry {
	readonly status: "pending";
	readonly request: GuestJoinRequest;
}
interface ApprovedEntry {
	readonly status: "approved";
	readonly requestId: string;
	readonly record: GuestMembershipRecord;
	readonly capability: GuestApprovalCapability;
	readonly capabilityDigest?: string;
}
interface RevokedEntry {
	readonly status: "revoked";
	readonly record: GuestMembershipRecord;
}
interface DeniedEntry {
	readonly status: "denied";
	readonly request: GuestJoinRequest;
	readonly approver?: string;
}
type Entry = PendingEntry | ApprovedEntry | RevokedEntry | DeniedEntry;

function validText(value: string): boolean {
	return value.length > 0 && value.trim() === value && !value.includes("\0") && !/[\r\n]/.test(value);
}

export function createGuestAdmissionRuntime(deps: GuestAdmissionRuntimeDependencies): GuestAdmissionRuntime {
	const states = new Map<string, Entry>();
	const selector = deps.manifest.crew ? crewSelectorFromConfig(deps.manifest.crew) : undefined;
	let capabilityIndex = 0;
	const createCapability =
		deps.createCapability ?? (() => `${deps.memberName}:guest-capability-${++capabilityIndex}`);
	const authorized = (name: string) =>
		guestAdmissionPolicy(deps.manifest.guestAdmission).enabled &&
		deps.manifest.guestAdmission!.approvers.includes(name);
	const persist = () => {
		deps.persist?.(
			[...states.values()]
				.filter(
					(entry): entry is ApprovedEntry | RevokedEntry | DeniedEntry =>
						entry.status === "approved" || entry.status === "revoked" || entry.status === "denied",
				)
				.map((entry) => {
					if (entry.status === "denied")
						return {
							status: entry.status,
							request: entry.request,
							...(entry.approver === undefined ? {} : { approver: entry.approver }),
						};
					if (entry.status === "revoked") return { status: entry.status, record: entry.record };
					return {
						status: entry.status,
						record: entry.record,
						...(entry.capabilityDigest === undefined ? {} : { capabilityDigest: entry.capabilityDigest }),
					};
				}),
		);
	};
	const list = (): readonly GuestAdmissionView[] =>
		[...states.values()]
			.map((entry) => {
				if (entry.status === "pending")
					return {
						status: entry.status,
						requestId: entry.request.requestId,
						crew: entry.request.crew,
						guestIdentity: entry.request.guestIdentity,
						guestName: entry.request.guestName,
					};
				if (entry.status === "denied")
					return {
						status: entry.status,
						crew: entry.request.crew,
						guestIdentity: entry.request.guestIdentity,
						guestName: entry.request.guestName,
					};
				return {
					status: entry.status,
					crew: entry.record.crew,
					guestIdentity: entry.record.guestIdentity,
					guestName: entry.record.guestName,
					...(entry.status === "approved" ? { approvedBy: entry.record.approvedBy } : {}),
				};
			})
			.sort((a, b) => a.guestName.localeCompare(b.guestName));

	return {
		receive(request) {
			if (!selector || !guestAdmissionPolicy(deps.manifest.guestAdmission).enabled)
				return { ok: false, code: "guest-disabled" };
			if (!isGuestJoinRequest(request)) return { ok: false, code: "invalid-request" };
			if (
				request.crew.id !== selector.id ||
				request.crew.displayName !== selector.displayName ||
				request.submittedByMember !== deps.memberName
			)
				return { ok: false, code: "crew-mismatch" };
			const current = states.get(request.guestIdentity);
			if (current?.status === "revoked") return { ok: false, code: "revoked" };
			if (current?.status === "denied") return { ok: false, code: "denied" };
			if (current?.status === "approved") {
				if (
					current.record.guestName !== request.guestName ||
					current.record.callbackEndpoint !== request.callbackEndpoint
				)
					return { ok: false, code: "name-collision" };
				return { ok: true, status: "approved", requestId: request.requestId, crew: selector, idempotent: true };
			}
			if (
				[...states.values()].some(
					(entry) =>
						entry.status === "approved" &&
						entry.record.guestName === request.guestName &&
						entry.record.guestIdentity !== request.guestIdentity,
				)
			)
				return { ok: false, code: "name-collision" };
			if (current?.status === "pending") {
				const same =
					current.request.guestName === request.guestName &&
					current.request.callbackEndpoint === request.callbackEndpoint;
				return same
					? {
							ok: true,
							status: "pending",
							requestId: current.request.requestId,
							crew: selector,
							idempotent: true,
						}
					: { ok: false, code: "name-collision" };
			}
			const acceptedRequest = { ...request, requestId: deps.createRequestId() };
			states.set(request.guestIdentity, { status: "pending", request: acceptedRequest });
			return {
				ok: true,
				status: "pending",
				requestId: acceptedRequest.requestId,
				crew: selector,
				idempotent: false,
			};
		},
		approve(requestId, approver, capability = createCapability()) {
			if (!authorized(approver)) return { ok: false, code: "unauthorized" };
			if (!validText(requestId) || !validText(approver)) return { ok: false, code: "approval-mismatch" };
			const entry = [...states.values()].find(
				(candidate): candidate is PendingEntry =>
					candidate.status === "pending" && candidate.request.requestId === requestId,
			);
			if (!entry) {
				const existing = [...states.values()].find(
					(candidate): candidate is ApprovedEntry =>
						candidate.status === "approved" && candidate.requestId === requestId,
				);
				if (existing && existing.requestId === requestId)
					return { ok: true, record: existing.record, capability: existing.capability, idempotent: true };
				return existing ? { ok: false, code: "approval-mismatch" } : { ok: false, code: "not-found" };
			}
			try {
				// Built explicitly: a persisted record must satisfy the strict
				// GuestMembershipRecord schema so admission restore can accept it.
				const record: GuestMembershipRecord = {
					crew: entry.request.crew,
					guestIdentity: entry.request.guestIdentity,
					guestName: entry.request.guestName,
					callbackEndpoint: entry.request.callbackEndpoint,
					approvedBy: approver,
				};
				const bound = bindGuestApprovalCapability(capability);
				const capabilityDigest = deps.digestCapability?.(bound);
				states.set(entry.request.guestIdentity, {
					status: "approved",
					requestId,
					record,
					capability: bound,
					...(capabilityDigest === undefined ? {} : { capabilityDigest }),
				});
				persist();
				return { ok: true, record, capability: bound, idempotent: false };
			} catch {
				return { ok: false, code: "approval-failed" };
			}
		},
		deny(requestId, approver) {
			if (!authorized(approver)) return { ok: false, code: "unauthorized" };
			for (const [identity, entry] of states) {
				if (entry.status === "pending" && entry.request.requestId === requestId) {
					states.set(identity, { status: "denied", request: entry.request, approver });
					persist();
					return { ok: true, changed: true };
				}
			}
			return { ok: false, code: "not-found" };
		},
		remove(guestName, approver) {
			if (!authorized(approver)) return { ok: false, code: "unauthorized" };
			for (const [identity, entry] of states) {
				if (entry.status === "approved" && entry.record.guestName === guestName) {
					states.set(identity, { status: "revoked", record: entry.record });
					persist();
					return { ok: true, changed: true };
				}
			}
			return { ok: false, code: "not-found" };
		},
		revoke(guestIdentity, crewId, callbackEndpoint) {
			const entry = states.get(guestIdentity);
			if (
				!entry ||
				entry.status !== "approved" ||
				entry.record.crew.id !== crewId ||
				entry.record.callbackEndpoint !== callbackEndpoint
			)
				return { ok: false, code: "not-found" };
			states.set(guestIdentity, { status: "revoked", record: entry.record });
			persist();
			return { ok: true, changed: true };
		},
		list,
		restore(records) {
			const restored: string[] = [];
			const rejected: string[] = [];
			for (const candidate of records) {
				const snapshot =
					candidate && typeof candidate === "object" && ("record" in candidate || "request" in candidate)
						? (candidate as { status?: string; record?: unknown; request?: unknown })
						: undefined;
				if (
					!candidate ||
					typeof candidate !== "object" ||
					(!("guestIdentity" in candidate) && !snapshot?.record && !snapshot?.request)
				) {
					rejected.push("unknown");
					continue;
				}
				const record = (snapshot?.record ?? candidate) as GuestMembershipRecord;
				const deniedRequest =
					snapshot?.status === "denied" ? (snapshot as { request?: unknown }).request : undefined;
				if (deniedRequest !== undefined) {
					if (!selector || !isGuestJoinRequest(deniedRequest) || deniedRequest.crew.id !== selector.id) {
						rejected.push("unknown");
						continue;
					}
					states.set(deniedRequest.guestIdentity, { status: "denied", request: deniedRequest });
					restored.push(deniedRequest.guestIdentity);
					continue;
				}
				if (
					!selector ||
					!isGuestMembershipRecord(record) ||
					// A record maps back to its admission request without approvedBy
					// (join requests never carry it) and only for this crew.
					!isGuestJoinRequest({
						requestId: "restore",
						crew: record.crew,
						guestIdentity: record.guestIdentity,
						guestName: record.guestName,
						callbackEndpoint: record.callbackEndpoint,
						submittedByMember: deps.memberName,
					}) ||
					record.crew.id !== selector.id ||
					!authorized(record.approvedBy)
				) {
					rejected.push(record.guestIdentity || "unknown");
					continue;
				}
				try {
					if (snapshot?.status === "revoked") states.set(record.guestIdentity, { status: "revoked", record });
					else {
						const rawDigest = (snapshot as { capabilityDigest?: unknown } | undefined)?.capabilityDigest;
						let capabilityDigest: string | undefined;
						if (rawDigest !== undefined) {
							if (!isGuestRegistryCapabilityDigest(rawDigest)) {
								rejected.push(record.guestIdentity);
								continue;
							}
							capabilityDigest = rawDigest;
						}
						states.set(record.guestIdentity, {
							status: "approved",
							requestId: "restored",
							record,
							capability: bindGuestApprovalCapability(createCapability()),
							...(capabilityDigest === undefined ? {} : { capabilityDigest }),
						});
					}
					restored.push(record.guestIdentity);
				} catch {
					rejected.push(record.guestIdentity);
				}
			}
			return { restored, rejected };
		},
	};
}

export type { GuestApproval };
export function guestApprovalFromPending(request: GuestJoinRequest, approver: string): GuestApproval {
	return {
		requestId: request.requestId,
		crew: request.crew,
		guestIdentity: request.guestIdentity,
		guestName: request.guestName,
		callbackEndpoint: request.callbackEndpoint,
		approver,
	};
}
