import {
	bindGuestApprovalCapability,
	crewSelectorFromConfig,
	guestAdmissionPolicy,
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
	readonly persist?: (records: readonly GuestMembershipRecord[]) => void;
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
}
interface RevokedEntry {
	readonly status: "revoked";
	readonly record: GuestMembershipRecord;
}
type Entry = PendingEntry | ApprovedEntry | RevokedEntry;

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
				.filter((entry): entry is ApprovedEntry => entry.status === "approved")
				.map((entry) => entry.record),
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
				const record: GuestMembershipRecord = { ...entry.request, approvedBy: approver };
				delete (record as Partial<GuestMembershipRecord> & { submittedByMember?: string }).submittedByMember;
				const bound = bindGuestApprovalCapability(capability);
				states.set(entry.request.guestIdentity, { status: "approved", requestId, record, capability: bound });
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
					states.delete(identity);
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
				if (!candidate || typeof candidate !== "object" || !("guestIdentity" in candidate)) {
					rejected.push("unknown");
					continue;
				}
				const record = candidate as GuestMembershipRecord;
				if (
					!selector ||
					!isGuestMembershipRecord(record) ||
					!isGuestJoinRequest({ ...record, requestId: "restore", submittedByMember: deps.memberName }) ||
					record.crew.id !== selector.id ||
					!authorized(record.approvedBy)
				) {
					rejected.push(record.guestIdentity || "unknown");
					continue;
				}
				try {
					states.set(record.guestIdentity, {
						status: "approved",
						requestId: "restored",
						record,
						capability: bindGuestApprovalCapability(createCapability()),
					});
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
