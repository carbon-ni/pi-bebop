import {
	bindGuestApprovalCapability,
	isGuestApproval,
	isGuestJoinRequest,
	isGuestMembershipRecord,
	type GuestApproval,
	type GuestApprovalCapability,
	type GuestJoinRequest,
	type GuestMembershipRecord,
	type CrewSelector,
} from "../domain/index.ts";

// Guest runtime state is intentionally separate from configured Member membership.
export interface GuestMembershipRecordInput {
	readonly crew: CrewSelector;
	readonly guestName: string;
	readonly memberSocket: string;
	readonly submittedByMember: string;
}

export type GuestMembershipView =
	| {
			readonly status: "pending";
			readonly requestId: string;
			readonly crew: CrewSelector;
			readonly guestIdentity: string;
			readonly guestName: string;
	  }
	| {
			readonly status: "approved";
			readonly crew: CrewSelector;
			readonly guestIdentity: string;
			readonly guestName: string;
			readonly approvedBy: string;
	  };

export type GuestJoinResult =
	| { readonly ok: true; readonly status: "pending"; readonly requestId: string; readonly idempotent: boolean }
	| { readonly ok: true; readonly status: "approved"; readonly idempotent: boolean }
	| { readonly ok: false; readonly code: "conflicting-pending" | "join-failed" };

export type GuestApprovalResult =
	| { readonly ok: true; readonly status: "approved"; readonly idempotent: boolean }
	| { readonly ok: false; readonly code: "approval-mismatch" | "approval-failed" };

export type GuestLeaveResult =
	| { readonly ok: true; readonly left: boolean }
	| { readonly ok: false; readonly code: "invalid-crew" };

export interface GuestMembershipRuntime {
	join(input: GuestMembershipRecordInput): Promise<GuestJoinResult>;
	track(input: GuestMembershipRecordInput, requestId: string, status?: "pending" | "approved"): GuestJoinResult;
	approve(approval: GuestApproval, capability?: string): Promise<GuestApprovalResult>;
	leave(crewId: string): Promise<GuestLeaveResult>;
	getMemberSocket(crewId: string): string | null;
	list(): readonly GuestMembershipView[];
	restore(records: readonly unknown[]): {
		readonly restored: readonly string[];
		readonly rejected: readonly string[];
	};
}

interface PendingMembership {
	readonly status: "pending";
	readonly request: GuestJoinRequest;
	readonly memberSocket: string;
}

interface ApprovedMembership {
	readonly status: "approved";
	readonly record: GuestMembershipRecord;
	readonly capability: GuestApprovalCapability;
	readonly memberSocket: string | null;
}

type GuestMembershipState = PendingMembership | ApprovedMembership;

export interface GuestMembershipRuntimeDependencies {
	readonly guestIdentity: string | (() => string);
	readonly callbackEndpoint: string | (() => string);
	readonly submitJoinRequest: (request: GuestJoinRequest) => Promise<void>;
	readonly createRequestId: () => string;
	readonly createCapability?: () => string;
	readonly crewOrder?: readonly string[];
	readonly persist?: (records: readonly GuestMembershipRecord[]) => void;
}

function validText(value: string): boolean {
	return value.length > 0 && value.trim() === value && !value.includes("\0");
}

function stateView(state: GuestMembershipState, callbackEndpoint: string): GuestMembershipView {
	if (state.status === "pending") {
		return {
			status: "pending",
			requestId: state.request.requestId,
			crew: state.request.crew,
			guestIdentity: state.request.guestIdentity,
			guestName: state.request.guestName,
		};
	}
	return {
		status: "approved",
		crew: state.record.crew,
		guestIdentity: state.record.guestIdentity,
		guestName: state.record.guestName,
		approvedBy: state.record.approvedBy,
	};
}

function recordWithEndpoint(record: GuestMembershipRecord, callbackEndpoint: string): GuestMembershipRecord {
	return { ...record, callbackEndpoint };
}

function approvedRecords(states: ReadonlyMap<string, GuestMembershipState>): readonly GuestMembershipRecord[] {
	return [...states.values()]
		.filter((state): state is ApprovedMembership => state.status === "approved")
		.map((state) => state.record);
}

/**
 * Owns a Guest's zero-to-many independent Crew memberships. Network transport,
 * approval authorization, and persistence remain injected boundaries; this
 * runtime only enforces identity matching and Crew-local state transitions.
 */
export function createGuestMembershipRuntime(dependencies: GuestMembershipRuntimeDependencies): GuestMembershipRuntime {
	const states = new Map<string, GuestMembershipState>();
	let capabilityIndex = 0;
	const getGuestIdentity = () =>
		typeof dependencies.guestIdentity === "function" ? dependencies.guestIdentity() : dependencies.guestIdentity;
	const createCapability =
		dependencies.createCapability ?? (() => `${getGuestIdentity()}:guest-capability-${++capabilityIndex}`);
	const getCallbackEndpoint = () =>
		typeof dependencies.callbackEndpoint === "function"
			? dependencies.callbackEndpoint()
			: dependencies.callbackEndpoint;

	const track = (
		input: GuestMembershipRecordInput,
		requestId: string,
		status: "pending" | "approved" = "pending",
	): GuestJoinResult => {
		const callbackEndpoint = getCallbackEndpoint();
		if (!validText(getGuestIdentity()) || !validText(callbackEndpoint) || !validText(requestId))
			return { ok: false, code: "join-failed" };
		const current = states.get(input.crew.id);
		if (current?.status === "approved") {
			return current.record.guestName === input.guestName
				? { ok: true, status: "approved", idempotent: true }
				: { ok: false, code: "conflicting-pending" };
		}
		const request: GuestJoinRequest = {
			requestId,
			crew: input.crew,
			guestIdentity: getGuestIdentity(),
			guestName: input.guestName,
			callbackEndpoint,
			submittedByMember: input.submittedByMember,
		};
		if (!isGuestJoinRequest(request)) return { ok: false, code: "join-failed" };
		if (status === "approved") {
			states.set(input.crew.id, {
				status: "approved",
				memberSocket: input.memberSocket,
				record: {
					crew: input.crew,
					guestIdentity: getGuestIdentity(),
					guestName: input.guestName,
					callbackEndpoint,
					approvedBy: "remote-member",
				},
				capability: bindGuestApprovalCapability(createCapability()),
			});
			dependencies.persist?.(approvedRecords(states));
			return { ok: true, status: "approved", idempotent: false };
		}
		states.set(input.crew.id, { status: "pending", request, memberSocket: input.memberSocket });
		return { ok: true, status: "pending", requestId, idempotent: false };
	};

	return {
		track,
		async join(input) {
			const callbackEndpoint = getCallbackEndpoint();
			if (!validText(getGuestIdentity()) || !validText(callbackEndpoint))
				return { ok: false, code: "join-failed" };
			const current = states.get(input.crew.id);
			if (current?.status === "approved") {
				return current.record.guestName === input.guestName
					? { ok: true, status: "approved", idempotent: true }
					: { ok: false, code: "conflicting-pending" };
			}
			const request: GuestJoinRequest = {
				requestId: current?.request.requestId ?? dependencies.createRequestId(),
				crew: input.crew,
				guestIdentity: getGuestIdentity(),
				guestName: input.guestName,
				callbackEndpoint,
				submittedByMember: input.submittedByMember,
			};
			if (current?.status === "pending") {
				const same =
					current.request.guestName === request.guestName &&
					current.request.callbackEndpoint === request.callbackEndpoint &&
					current.request.submittedByMember === request.submittedByMember;
				return same
					? { ok: true, status: "pending", requestId: request.requestId, idempotent: true }
					: { ok: false, code: "conflicting-pending" };
			}
			if (!isGuestJoinRequest(request)) return { ok: false, code: "join-failed" };
			try {
				await dependencies.submitJoinRequest(request);
			} catch {
				return { ok: false, code: "join-failed" };
			}
			states.set(input.crew.id, { status: "pending", request, memberSocket: input.memberSocket });
			return { ok: true, status: "pending", requestId: request.requestId, idempotent: false };
		},

		async approve(approval, capability = createCapability()) {
			const current = states.get(approval.crew.id);
			if (!current || !isGuestApproval(approval)) return { ok: false, code: "approval-mismatch" };
			if (current.status === "approved") {
				const record = current.record;
				const same =
					record.crew.id === approval.crew.id &&
					record.crew.displayName === approval.crew.displayName &&
					record.guestIdentity === approval.guestIdentity &&
					record.guestName === approval.guestName &&
					record.callbackEndpoint === approval.callbackEndpoint &&
					record.approvedBy === approval.approver;
				let sameCapability = false;
				try {
					sameCapability = current.capability === bindGuestApprovalCapability(capability);
				} catch {
					// A malformed replayed capability fails closed.
				}
				return same && sameCapability
					? { ok: true, status: "approved", idempotent: true }
					: { ok: false, code: "approval-mismatch" };
			}
			const request = current.request;
			if (
				request.requestId !== approval.requestId ||
				request.crew.id !== approval.crew.id ||
				request.crew.displayName !== approval.crew.displayName ||
				request.guestIdentity !== approval.guestIdentity ||
				request.guestName !== approval.guestName ||
				request.callbackEndpoint !== approval.callbackEndpoint
			)
				return { ok: false, code: "approval-mismatch" };
			try {
				const boundCapability = bindGuestApprovalCapability(capability);
				states.set(approval.crew.id, {
					status: "approved",
					memberSocket: current.memberSocket,
					record: {
						crew: approval.crew,
						guestIdentity: approval.guestIdentity,
						guestName: approval.guestName,
						callbackEndpoint: approval.callbackEndpoint,
						approvedBy: approval.approver,
					},
					capability: boundCapability,
				});
				dependencies.persist?.(approvedRecords(states));
				return { ok: true, status: "approved", idempotent: false };
			} catch {
				return { ok: false, code: "approval-failed" };
			}
		},

		async leave(crewId) {
			if (!validText(crewId)) return { ok: false, code: "invalid-crew" };
			const left = states.delete(crewId);
			if (left) dependencies.persist?.(approvedRecords(states));
			return { ok: true, left };
		},

		getMemberSocket(crewId) {
			const state = states.get(crewId);
			if (!state) return null;
			return state.status === "pending" ? state.memberSocket : state.memberSocket;
		},

		list() {
			const order = new Map((dependencies.crewOrder ?? []).map((id, index) => [id, index]));
			return [...states.entries()]
				.sort(
					([left], [right]) =>
						(order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER) ||
						left.localeCompare(right),
				)
				.map(([, state]) => stateView(state, getCallbackEndpoint()));
		},

		restore(records) {
			const restored: string[] = [];
			const rejected: string[] = [];
			for (const candidate of records) {
				if (
					!isGuestMembershipRecord(candidate) ||
					candidate.guestIdentity !== getGuestIdentity() ||
					states.has(candidate.crew.id)
				) {
					const id =
						candidate &&
						typeof candidate === "object" &&
						"crew" in candidate &&
						candidate.crew &&
						typeof candidate.crew === "object" &&
						"id" in candidate.crew &&
						typeof candidate.crew.id === "string"
							? candidate.crew.id
							: "unknown";
					rejected.push(id);
					continue;
				}
				const record = recordWithEndpoint(candidate, getCallbackEndpoint());
				try {
					states.set(record.crew.id, {
						status: "approved",
						memberSocket: null,
						record,
						capability: bindGuestApprovalCapability(createCapability()),
					});
					restored.push(record.crew.id);
				} catch {
					rejected.push(record.crew.id);
				}
			}
			if (restored.length > 0) dependencies.persist?.(approvedRecords(states));
			return { restored, rejected };
		},
	};
}
