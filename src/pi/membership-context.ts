import type { Membership } from "../infra/membership-runtime.ts";

export const MEMBERSHIP_ENTRY_TYPE = "intray-membership";
export const MEMBERSHIP_CONTEXT_MARKER = "## Current crew identity";

export interface PersistedMembershipState {
	readonly active: boolean;
	readonly socketPath: string;
	readonly manifestPath?: string;
}

export function getLatestMembershipState(entries: readonly unknown[]): PersistedMembershipState | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (
			entry.type !== "custom" ||
			entry.customType !== MEMBERSHIP_ENTRY_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		)
			continue;
		const data = entry.data as Partial<PersistedMembershipState>;
		if (typeof data.active !== "boolean" || typeof data.socketPath !== "string") continue;
		return {
			active: data.active,
			socketPath: data.socketPath,
			manifestPath: typeof data.manifestPath === "string" ? data.manifestPath : undefined,
		};
	}
	return null;
}

export function membershipStateFromRuntime(membership: Membership, active = true): PersistedMembershipState {
	return { active, socketPath: membership.socketPath, manifestPath: membership.manifestPath };
}

export function formatMembershipContext(membership: Membership): string {
	const members = membership.manifest.members
		.map((member) =>
			member.description
				? `${member.name} (${member.role}): ${member.description}`
				: `${member.name} (${member.role})`,
		)
		.join(", ");
	const commonInstructions = membership.manifest.commonInstructions
		? `\nCommon Crew instructions:\n${membership.manifest.commonInstructions}`
		: "";
	const agreements = membership.manifest.crewAgreements?.content
		? `\nCurrent Crew Agreements:\n${membership.manifest.crewAgreements.content}`
		: "";
	const instructions = membership.member.instructions ? `\nRole instructions: ${membership.member.instructions}` : "";
	// Crew contact is the exact manifest member selected by intake.contact to triage
	// unverified external Crew Intake. It is derived only from the trusted manifest
	// snapshot; never inferred as lead/product/first/online, never a fallback, and
	// never duplicated role/name fields. It grants no extra tool or visibility
	// permission and is not an internal routing target.
	const contactName = membership.manifest.intake?.contact;
	const contact = contactName ? membership.manifest.members.find((member) => member.name === contactName) : undefined;
	const contactLine = contact
		? `Crew contact: ${contact.name} (${contact.role}) — external Intake triage`
		: "Crew contact: none (Crew Intake disabled)";
	const coordination =
		"Coordination: use send_member_request to send a Member request (you are the Requester and alone wait for its outcome with wait_for_request_outcome); when you receive a Member request you are the Responder and send one correlated Response with respond_to_member_request; use send_follow_up for information only — no correlated Response is expected, and never infer response causality from Follow-up arrival order (a queued Follow-up may predate newer coordination).";
	const board =
		"Crew Board: use read_crew_board to inspect shared Posts and leave_crew_post to add one. Posts are not delivered automatically.";
	const crewNameLine = membership.manifest.name === undefined ? "" : `\nCrew name: ${membership.manifest.name}`;
	return `${MEMBERSHIP_CONTEXT_MARKER}\nMember: ${membership.member.name}\nRole: ${membership.member.role}\nCrew: ${membership.manifestPath}${crewNameLine}\nMembers: ${members}\n${contactLine}\n${coordination}${commonInstructions}${agreements}${instructions}\n${board}`;
}

export function appendMembershipContext(systemPrompt: string, membership: Membership | null): string {
	if (!membership || systemPrompt.includes(MEMBERSHIP_CONTEXT_MARKER)) return systemPrompt;
	return `${systemPrompt}\n\n${formatMembershipContext(membership)}`;
}
