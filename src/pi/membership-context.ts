import type { Membership } from "../infra/membership-runtime.ts";
import { GUEST_CAPABILITIES } from "../domain/index.ts";
import type { GuestMembershipRecord } from "../domain/index.ts";
import type { GuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";

export const MEMBERSHIP_ENTRY_TYPE = "intray-membership";
export const GUEST_MEMBERSHIP_ENTRY_TYPE = "intray-guest-memberships";
export const MEMBERSHIP_CONTEXT_MARKER = "## Current crew identity";
export const GUEST_MEMBERSHIP_CONTEXT_MARKER = "## Current Guest identity";

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

export function getLatestGuestMembershipRecords(entries: readonly unknown[]): readonly unknown[] {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== GUEST_MEMBERSHIP_ENTRY_TYPE || !Array.isArray(entry.data))
			continue;
		return entry.data
			.map((candidate) => {
				if (candidate && typeof candidate === "object" && ("record" in candidate || "request" in candidate)) {
					const snapshot = candidate as { status?: string; record?: unknown };
					return snapshot.status === "approved" ? snapshot.record : undefined;
				}
				return candidate;
			})
			.filter((candidate): candidate is unknown => candidate !== undefined);
	}
	return [];
}

export function getLatestGuestAdmissionRecords(entries: readonly unknown[]): readonly unknown[] {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type === "custom" && entry.customType === GUEST_MEMBERSHIP_ENTRY_TYPE && Array.isArray(entry.data))
			return entry.data;
	}
	return [];
}

export function guestMembershipStateFromRuntime(
	records: readonly GuestMembershipRecord[],
): readonly GuestMembershipRecord[] {
	return records.map((record) => ({ ...record, crew: { ...record.crew } }));
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
		? `\nCommon crew instructions: ${membership.manifest.commonInstructions}`
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
		"Coordination: use send_member_request to send a Member request (you are the Requester and alone wait for its outcome with wait_for_request_outcome); when you receive a Member request you are the Responder and send one correlated Response with respond_to_member_request; use send_follow_up for information only — no correlated Response is expected.";
	return `${MEMBERSHIP_CONTEXT_MARKER}\nMember: ${membership.member.name}\nRole: ${membership.member.role}\nCrew: ${membership.manifestPath}\nMembers: ${members}\n${contactLine}\n${coordination}${commonInstructions}${instructions}`;
}

export function appendMembershipContext(systemPrompt: string, membership: Membership | null): string {
	if (!membership || systemPrompt.includes(MEMBERSHIP_CONTEXT_MARKER)) return systemPrompt;
	return `${systemPrompt}\n\n${formatMembershipContext(membership)}`;
}

/** Model-visible Guest context contains selectors and capabilities, never routes or credentials. */
export function formatGuestMembershipContext(runtime: GuestMembershipRuntime): string {
	const memberships = runtime.list();
	const crews =
		memberships.length === 0
			? "none"
			: memberships
					.map(
						(row) =>
							`${row.crew.id} (${row.crew.displayName}) — ${row.status}${row.status === "pending" ? ` (${row.requestId})` : ""}`,
					)
					.join(", ");
	const capabilities = GUEST_CAPABILITIES.join(", ");
	return `${GUEST_MEMBERSHIP_CONTEXT_MARKER}\nGuest crews: ${crews}\nGuest capabilities: ${capabilities}\nGuest messaging requires the exact crew selector on every action. Guest supports direct Follow-ups, correlated Member Requests/Responses, and transient Crew Broadcast; Guest cannot use Inbox, Redirect, Interrupt, Member administration, or Crew control. Presence is separate from approval: offline or unreachable does not revoke Guest admission.`;
}

export function appendGuestMembershipContext(systemPrompt: string, runtime: GuestMembershipRuntime | null): string {
	if (!runtime || systemPrompt.includes(GUEST_MEMBERSHIP_CONTEXT_MARKER)) return systemPrompt;
	return `${systemPrompt}\n\n${formatGuestMembershipContext(runtime)}`;
}
