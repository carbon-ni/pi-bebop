import type { CrewMember } from "./crew-manifest.ts";

export type CrewMemberAvailability = "current" | "online" | "offline";
export type CrewListRow = { readonly member: CrewMember; readonly status: CrewMemberAvailability };

export function formatCrewList(manifestPath: string, rows: readonly CrewListRow[]): string {
	const lines = [`Crew: ${manifestPath}`, `Members (${rows.length}):`];
	for (const { member, status } of rows)
		lines.push(`- ${member.name} (${member.role}) — ${status} — ${member.socketPath}`);
	return lines.join("\n");
}
