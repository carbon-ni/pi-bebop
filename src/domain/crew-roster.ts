import type { CrewMember } from "./crew-manifest.ts";

export type CrewMemberAvailability = "current" | "online" | "offline";
export type CrewRosterRow = { readonly member: CrewMember; readonly status: CrewMemberAvailability };

export function formatCrewRoster(manifestPath: string, rows: readonly CrewRosterRow[]): string {
	const lines = [`Crew: ${manifestPath}`, `Members (${rows.length}):`];
	for (const { member, status } of rows)
		lines.push(`- ${member.name} (${member.role}) — ${status} — ${member.socketPath}`);
	return lines.join("\n");
}
