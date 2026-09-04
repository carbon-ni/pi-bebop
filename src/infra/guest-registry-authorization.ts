import { getCrewManifestPathFromSocketPath } from "./crew-layout.ts";
import { createGuestRegistryStore, digestGuestCapability } from "./guest-registry-store.ts";
import { authorizeGuestSendAgainstRegistry, type GuestSendAuthorizationResult } from "./guest-admission-runtime.ts";
import type { GuestMembershipRuntime } from "./guest-membership-runtime.ts";

/**
 * Build the Guest callback authorization boundary used by composition. The
 * source of truth is derived from the Guest's approved membership endpoint;
 * registry data is loaded for every operation and never cached.
 */
export function createGuestRegistryAuthorizationResolver(options: {
	runtime: Pick<GuestMembershipRuntime, "list" | "getMemberSocket">;
	isProjectTrusted: () => boolean;
}): (input: {
	crewId: string;
	guestIdentity: string;
	callbackEndpoint: string;
	capability: string;
}) => GuestSendAuthorizationResult {
	return (input) => {
		const membership = options.runtime
			.list()
			.find((row) => row.crew.id === input.crewId && row.status === "approved");
		const memberSocket = options.runtime.getMemberSocket(input.crewId);
		if (!membership || !memberSocket || !options.isProjectTrusted())
			return { ok: false, code: "registry-unavailable" };
		try {
			const manifestPath = getCrewManifestPathFromSocketPath(memberSocket);
			const registry = createGuestRegistryStore({ manifestPath, crew: membership.crew });
			return authorizeGuestSendAgainstRegistry(() => registry.load(), digestGuestCapability, input);
		} catch {
			return { ok: false, code: "registry-unavailable" };
		}
	};
}
