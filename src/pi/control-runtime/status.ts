import type { Membership } from "../../infra/membership-runtime.ts";

export type IntrayStatus = "stopped" | "online" | "joined";

export function deriveIntrayStatus(serverPresent: boolean, membershipActive: boolean): IntrayStatus {
	if (!serverPresent) return "stopped";
	return membershipActive ? "joined" : "online";
}

export function formatIntrayFooter(status: IntrayStatus, member?: Pick<Membership["member"], "name" | "role">): string {
	const identity = status === "joined" && member ? ` ${member.name} (${member.role})` : "";
	return `${status}${identity}`;
}
