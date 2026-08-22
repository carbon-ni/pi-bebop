import { formatCrewPresenceEffect, type PresenceEffect, type PresenceMember } from "../domain/index.ts";

export function emitCrewPresenceActivity(
	effects: readonly PresenceEffect[],
	membership: {
		readonly members: readonly PresenceMember[];
		readonly currentIdentity: string;
		readonly notifications: boolean;
	} | null,
	send: (
		message: { customType: "crew-presence"; content: string; display: true },
		options: { triggerTurn: false },
	) => void,
): void {
	if (!membership || !membership.notifications) return;
	for (const effect of effects) {
		if (
			effect.type !== "roster" &&
			!membership.members.some(
				(member) =>
					member.identity === effect.member.identity &&
					member.name === effect.member.name &&
					member.role === effect.member.role,
			)
		)
			continue;
		send(
			{
				customType: "crew-presence",
				content: formatCrewPresenceEffect(effect, membership.members, membership.currentIdentity),
				display: true,
			},
			{ triggerTurn: false },
		);
	}
}
