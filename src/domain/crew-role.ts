import type { CrewManifest, CrewMember } from "./crew-manifest.ts";

export const MAX_ROLE_HINTS = 8;

export type CrewRoleSelection =
	| { readonly kind: "match"; readonly member: CrewMember }
	| {
			readonly kind: "empty-role";
			readonly role: string;
	  }
	| {
			readonly kind: "unknown-role";
			readonly role: string;
			readonly availableRoles: readonly string[];
			readonly omittedRoleCount: number;
	  }
	| { readonly kind: "ambiguous-role"; readonly role: string };

/** Pure, exact role selection. Socket paths always come from the manifest member. */
export function selectCrewMemberByRole(manifest: CrewManifest, role: string): CrewRoleSelection {
	const normalized = role.trim();
	if (!normalized) return { kind: "empty-role", role };
	const matches = manifest.members.filter((member) => member.role === normalized);
	if (matches.length === 1) return { kind: "match", member: matches[0]! };
	if (matches.length > 1) return { kind: "ambiguous-role", role: normalized };
	const roles = [...new Set(manifest.members.map((member) => member.role))];
	return {
		kind: "unknown-role",
		role: normalized,
		availableRoles: roles.slice(0, MAX_ROLE_HINTS),
		omittedRoleCount: Math.max(0, roles.length - MAX_ROLE_HINTS),
	};
}
