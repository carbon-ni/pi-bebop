import type { PresenceEffect, PresenceMember } from "./presence.ts";

export const CREW_PRESENCE_PREVIEW_LIMIT = 8;
export const CREW_PRESENCE_CUSTOM_TYPE = "crew-presence";

export type CrewPresenceRoster = Extract<PresenceEffect, { readonly type: "roster" }>;

function safeLabel(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function label(member: PresenceMember, currentIdentity: string): string {
	const name = safeLabel(member.name);
	const role = safeLabel(member.role);
	return member.identity === currentIdentity ? `${name} (you)` : `${name} (${role})`;
}

export function formatCrewPresenceRoster(
	effect: CrewPresenceRoster,
	configuredMembers: readonly PresenceMember[],
	currentIdentity: string,
	previewLimit = CREW_PRESENCE_PREVIEW_LIMIT,
): string {
	const statuses = new Map(effect.members.map((member) => [member.identity, member.status]));
	const online = configuredMembers.filter((member) => {
		const status = statuses.get(member.identity);
		return member.identity === currentIdentity || status === "online" || status === "suspect";
	});
	const total = online.length;
	const limit = Math.max(1, previewLimit);
	let visible = online.slice(0, limit);
	const current = online.find((member) => member.identity === currentIdentity);
	if (current && !visible.some((member) => member.identity === currentIdentity)) visible = [...visible, current];
	const omitted = Math.max(0, total - visible.length);
	const suffix = omitted > 0 ? ` (+${omitted} more; use /crew members)` : "";
	return `[crew] Online (${total}): ${visible.map((member) => label(member, currentIdentity)).join(", ") || "none"}${suffix}`;
}

export function formatCrewPresenceTransition(
	effect: Extract<PresenceEffect, { readonly type: "joined" | "left" }>,
): string {
	return `[crew] ${safeLabel(effect.member.name)} (${safeLabel(effect.member.role)}) ${effect.type}`;
}

export function formatCrewPresenceEffect(
	effect: PresenceEffect,
	configuredMembers: readonly PresenceMember[],
	currentIdentity: string,
	previewLimit = CREW_PRESENCE_PREVIEW_LIMIT,
): string {
	return effect.type === "roster"
		? formatCrewPresenceRoster(effect, configuredMembers, currentIdentity, previewLimit)
		: formatCrewPresenceTransition(effect);
}
