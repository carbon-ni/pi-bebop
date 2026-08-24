import {
	createMemberFocusEntryData,
	createOfflineMemberStatus,
	createOnlineMemberStatus,
	isMemberStatus,
	MEMBER_FOCUS_ENTRY_TYPE,
	restoreMemberFocus,
	type AvailableMemberFocus,
	type MemberFocusEntryData,
	type MemberStatus,
	type MemberStatusIdentity,
} from "../domain/index.ts";

/**
 * Member status query + focus publishing (application, TASK-0047).
 *
 * Query is strictly read-only: reachability probe (finite), then one
 * `member.status` RPC when online. It never starts, steers, or interrupts the
 * target turn and never emits presence activity. Focus publishing mutates only
 * the current member's local session state via a typed `bebop-member-focus`
 * custom entry (context-free) and performs no RPC.
 *
 * The Pi surface is injected so this stays free of Pi types. Canonical member
 * identity is the member's configured socket path (TASK-0046).
 */

export type MemberStatusFlowErrorCode =
	| "not-joined"
	| "untrusted"
	| "unknown-member"
	| "ambiguous-member"
	| "self-query"
	| "invalid-action"
	| "invalid-focus"
	| "remote-rejected"
	| "malformed-response"
	| "timeout"
	| "aborted"
	| "transport-error";

export class MemberStatusFlowError extends Error {
	readonly code: MemberStatusFlowErrorCode;

	constructor(code: MemberStatusFlowErrorCode, message: string) {
		super(message);
		this.name = "MemberStatusFlowError";
		this.code = code;
	}
}

type CrewMember = { name: string; role: string; socketPath: string };
type CrewMembership = { member: CrewMember; socketPath: string; manifest: { members: readonly CrewMember[] } };

export interface MemberStatusSurface {
	readonly getMembership: () => CrewMembership | null;
	readonly isTrusted: () => boolean;
	readonly isIdle: () => boolean;
	readonly hasPendingMessages: () => boolean;
	readonly getEntries: () => readonly unknown[];
	readonly appendEntry: (customType: string, data?: unknown) => void;
	/** Finite-time endpoint reachability; failure is a compact offline result, never an error. */
	readonly probeEndpoint: (socketPath: string, signal?: AbortSignal) => Promise<boolean>;
	readonly requestStatus: (
		socketPath: string,
		memberLabel: string,
		signal?: AbortSignal,
	) => Promise<{ ok: true; status: MemberStatus } | { ok: false; code: MemberStatusFlowErrorCode }>;
	/** Cancellation signal propagated into the target probe/RPC (never leaves this surface). */
	readonly signal?: AbortSignal;
	readonly now: () => string;
}

function requireJoined(surface: MemberStatusSurface): CrewMembership {
	const membership = surface.getMembership();
	if (!membership) throw new MemberStatusFlowError("not-joined", "Not joined to a crew");
	if (!surface.isTrusted()) throw new MemberStatusFlowError("untrusted", "Project is not trusted");
	return membership;
}

function resolveTarget(membership: CrewMembership, memberLabel: string): CrewMember {
	const byName = membership.manifest.members.find((member) => member.name === memberLabel);
	const byRole = membership.manifest.members.filter((member) => member.role === memberLabel);
	const target = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!target) {
		if (byRole.length > 1)
			throw new MemberStatusFlowError("ambiguous-member", `Ambiguous crew role: ${memberLabel}`);
		throw new MemberStatusFlowError("unknown-member", `Unknown crew member: ${memberLabel}`);
	}
	if (target.name === membership.member.name || target.socketPath === membership.socketPath)
		throw new MemberStatusFlowError("self-query", "Cannot query your own status; use update_member_focus");
	return target;
}

function identityOf(member: CrewMember): MemberStatusIdentity {
	return { name: member.name, role: member.role };
}

export function createMemberStatusFlow(surface: MemberStatusSurface) {
	const queryStatus = async (memberLabel: string): Promise<MemberStatus> => {
		const membership = requireJoined(surface);
		const target = resolveTarget(membership, memberLabel.trim());
		const observedAt = surface.now();

		// Probe is the reachability boundary: failure is a compact offline result.
		// A signal-driven abort is NOT an offline observation: it stops the
		// probe/RPC early and reports the stable `aborted` code (exit 1), never
		// a successful offline status.
		const alive = await surface.probeEndpoint(target.socketPath, surface.signal);
		if (surface.signal?.aborted) throw new MemberStatusFlowError("aborted", "Member status query aborted");
		if (!alive) return createOfflineMemberStatus(identityOf(target), observedAt);

		const outcome = await surface.requestStatus(target.socketPath, target.name, surface.signal);
		if (outcome.ok === false)
			throw new MemberStatusFlowError(outcome.code, `Member status query failed: ${outcome.code}`);
		const status = outcome.status;
		// Malformed online peer output (invalid shape or foreign identity) is a protocol error.
		if (!isMemberStatus(status))
			throw new MemberStatusFlowError("malformed-response", "Member returned an invalid status");
		if (status.member.name !== target.name || status.member.role !== target.role)
			throw new MemberStatusFlowError("malformed-response", "Member returned status for a different identity");
		return status;
	};

	const updateFocus = async (action: "set" | "clear", focus?: string): Promise<AvailableMemberFocus> => {
		const membership = requireJoined(surface);
		if (action !== "set" && action !== "clear")
			throw new MemberStatusFlowError("invalid-action", "Focus action must be set or clear");
		const updatedAt = surface.now();
		let entry: MemberFocusEntryData;
		try {
			entry = createMemberFocusEntryData({
				memberIdentity: membership.member.socketPath,
				action,
				...(action === "set" ? { focus } : {}),
				updatedAt,
			});
		} catch {
			throw new MemberStatusFlowError(
				"invalid-focus",
				action === "set" ? "Focus must be a nonblank bounded single-line value" : "Invalid focus entry",
			);
		}
		surface.appendEntry(MEMBER_FOCUS_ENTRY_TYPE, entry);
		if (action === "clear" || entry.action === "clear") return { state: "unspecified" };
		return { state: "reported", text: entry.focus, updatedAt: entry.updatedAt };
	};

	const updateFocusResult = async (
		action: "set" | "clear",
		focus?: string,
	): Promise<{
		readonly status: "updated" | "replaced" | "cleared" | "unchanged";
		readonly focus: AvailableMemberFocus;
	}> => {
		const before = currentFocus();
		if (action === "clear" && before.state === "unspecified") return { status: "unchanged", focus: before };
		const next = await updateFocus(action, focus);
		if (action === "clear") return { status: "cleared", focus: next };
		return { status: before.state === "reported" ? "replaced" : "updated", focus: next };
	};

	/** Current member's latest matching focus/clear entry, scoped to canonical identity. */
	const currentFocus = (): AvailableMemberFocus => {
		const membership = requireJoined(surface);
		return restoreMemberFocus(surface.getEntries(), membership.member.socketPath);
	};

	return { queryStatus, updateFocus, updateFocusResult, currentFocus };
}
