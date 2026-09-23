import type { MemberLastMessageResult } from "../domain/index.ts";

export type MemberLastMessageFlowErrorCode =
	| "not-joined"
	| "untrusted"
	| "unknown-member"
	| "ambiguous-member"
	| "self-query"
	| "remote-rejected"
	| "offline-member"
	| "message-too-large"
	| "malformed-response"
	| "timeout"
	| "aborted"
	| "transport-error";

export class MemberLastMessageFlowError extends Error {
	readonly code: MemberLastMessageFlowErrorCode;

	constructor(code: MemberLastMessageFlowErrorCode, message: string) {
		super(message);
		this.name = "MemberLastMessageFlowError";
		this.code = code;
	}
}

type CrewMember = { name: string; role: string; socketPath: string };
type CrewMembership = { member: CrewMember; socketPath: string; manifest: { members: readonly CrewMember[] } };

export interface MemberLastMessageSurface {
	readonly getMembership: () => CrewMembership | null;
	readonly isTrusted: () => boolean;
	readonly probeEndpoint: (socketPath: string, signal?: AbortSignal) => Promise<boolean>;
	readonly requestLastMessage: (
		socketPath: string,
		signal?: AbortSignal,
	) => Promise<
		{ ok: true; message: MemberLastMessageResult["message"] } | { ok: false; code: MemberLastMessageFlowErrorCode }
	>;
	readonly signal?: AbortSignal;
}

function requireJoined(surface: MemberLastMessageSurface): CrewMembership {
	const membership = surface.getMembership();
	if (!membership) throw new MemberLastMessageFlowError("not-joined", "Not joined to a crew");
	if (!surface.isTrusted()) throw new MemberLastMessageFlowError("untrusted", "Project is not trusted");
	return membership;
}

function resolveTarget(membership: CrewMembership, memberLabel: string): CrewMember {
	const byName = membership.manifest.members.find((member) => member.name === memberLabel);
	const byRole = membership.manifest.members.filter((member) => member.role === memberLabel);
	const target = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!target) {
		if (byRole.length > 1)
			throw new MemberLastMessageFlowError("ambiguous-member", `Ambiguous crew role: ${memberLabel}`);
		throw new MemberLastMessageFlowError("unknown-member", `Unknown crew member: ${memberLabel}`);
	}
	if (target.name === membership.member.name || target.socketPath === membership.socketPath)
		throw new MemberLastMessageFlowError("self-query", "Cannot query your own last message");
	return target;
}

export function createMemberLastMessageFlow(surface: MemberLastMessageSurface) {
	const queryLastMessage = async (memberLabel: string): Promise<MemberLastMessageResult> => {
		const membership = requireJoined(surface);
		const target = resolveTarget(membership, memberLabel.trim());
		const alive = await surface.probeEndpoint(target.socketPath, surface.signal);
		if (surface.signal?.aborted) throw new MemberLastMessageFlowError("aborted", "Last-message query aborted");
		if (!alive) throw new MemberLastMessageFlowError("offline-member", "Member is offline");
		const outcome = await surface.requestLastMessage(target.socketPath, surface.signal);
		if (outcome.ok === false)
			throw new MemberLastMessageFlowError(outcome.code, `Last-message query failed: ${outcome.code}`);
		return { member: { name: target.name, role: target.role }, message: outcome.message };
	};

	return { queryLastMessage };
}
