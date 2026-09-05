import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SocketState } from "./control-runtime.ts";
import { ensureControlServer } from "./control-runtime.ts";
import { registerGuestControlCommand } from "./guest-control.ts";
import { getCrewManifestPathFromSocketPath, readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import { createGuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import { createGuestAdmissionRuntime } from "../infra/guest-admission-runtime.ts";
import { createGuestRegistryStore, digestGuestCapability } from "../infra/guest-registry-store.ts";
import { createGuestRegistryAuthorizationResolver } from "../infra/guest-registry-authorization.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { registerGuestMessagingTools, reconcileGuestMessagingTools } from "../tools/index.ts";

export interface ApprovedGuestRow {
	readonly guestName: string;
	readonly guestIdentity: string;
	readonly callbackEndpoint: string;
}

export interface GuestComposition {
	/** Rebuilds the crew-owned Guest admission authority; fail-closed on registry errors. */
	refreshAdmission(): void;
	/** Fresh approved-Guest view for Member->Guest addressing. */
	approvedGuests(): readonly ApprovedGuestRow[];
	/** Resolves a Guest crew selector to its manifest and approved guests. */
	loadManifest(crewId: string): Promise<{
		crew: { id: string; displayName: string };
		members: readonly unknown[];
		approvedGuests: readonly ApprovedGuestRow[];
	}>;
	/** Registers Guest messaging tools once an approved membership exists. */
	ensureMessagingTools(): void;
	/** Registers the `/crew guest` control command surface. */
	registerControlCommand(): void;
}

/**
 * Guest runtime wiring shared by every activation surface: membership runtime,
 * crew-owned admission registry, and Guest messaging tools. Dependency wiring
 * only — behavior lives in the runtimes this module composes.
 */
export function createGuestComposition(pi: ExtensionAPI, state: SocketState): GuestComposition {
	let guestRequestIndex = 0;
	/**
	 * Guest callbacks are addressed directly, so they cannot ask a Member to
	 * relay authorization. Resolve the joined Guest membership's configured
	 * Member endpoint back to its canonical project manifest and read that
	 * crew's registry fresh for every inbound Guest message.
	 */
	const authorizeGuestInbound = createGuestRegistryAuthorizationResolver({
		runtime: state.guestMembershipRuntime,
		isProjectTrusted: () => state.context?.isProjectTrusted?.() === true,
	});
	state.guestMembershipRuntime = createGuestMembershipRuntime({
		authorizeInbound: authorizeGuestInbound,
		guestIdentity: () => state.context?.sessionManager.getSessionId() ?? "",
		callbackEndpoint: () => state.socketPath ?? "",
		createRequestId: () => `guest-request-${++guestRequestIndex}`,
		submitJoinRequest: async () => undefined,
	});
	/** Set by refreshAdmission; fresh crew-registry reads for Member->Guest addressing. */
	let activeGuestRegistry: ReturnType<typeof createGuestRegistryStore> | null = null;
	/**
	 * Crew-owned Guest registry is the admission authority: persistence goes to
	 * the durable crew-shared store (never session-private entries), restore
	 * reads the registry, and verifier digests keep plaintext capabilities off
	 * disk. Registry failures disable admission fail-closed.
	 */
	const refreshAdmission = () => {
		const membership = state.membershipRuntime?.getMembership();
		if (!membership) {
			state.guestAdmissionRuntime = undefined;
			activeGuestRegistry = null;
			state.approvedGuestsResolver = undefined;
			return;
		}
		try {
			const registry = createGuestRegistryStore({
				manifestPath: membership.manifestPath,
				crew: membership.manifest.crew ?? { id: "unknown", displayName: "unknown" },
			});
			activeGuestRegistry = registry;
			state.approvedGuestsResolver = () =>
				registry
					.load()
					.entries.filter((entry) => entry.status === "approved")
					.map((entry) => ({
						guestName: entry.guestName,
						guestIdentity: entry.guestIdentity,
						callbackEndpoint: entry.callbackEndpoint,
					}));
			state.guestAdmissionRuntime = createGuestAdmissionRuntime({
				manifest: membership.manifest,
				memberName: membership.member.name,
				createRequestId: () => `guest-request-${++guestRequestIndex}`,
				digestCapability: digestGuestCapability,
				persist: (approved) => registry.replaceEntries(approved),
			});
			state.guestAdmissionRuntime?.restore(
				registry.load().entries.map((entry) =>
					entry.status === "denied"
						? {
								status: entry.status,
								request: {
									requestId: `registry-${entry.order}`,
									crew: entry.crew,
									guestIdentity: entry.guestIdentity,
									guestName: entry.guestName,
									callbackEndpoint: entry.callbackEndpoint,
									submittedByMember: membership.member.name,
								},
								approver: entry.approver,
							}
						: {
								status: entry.status,
								record: {
									crew: entry.crew,
									guestIdentity: entry.guestIdentity,
									guestName: entry.guestName,
									callbackEndpoint: entry.callbackEndpoint,
									approvedBy: entry.approver,
								},
								...(entry.status === "approved" ? { capabilityDigest: entry.capabilityDigest } : {}),
							},
				),
			);
		} catch (error) {
			// Fail closed: a registry that cannot be trusted disables admission.
			state.guestAdmissionRuntime = undefined;
			const message = `Crew guest registry unavailable: ${error instanceof Error ? error.message : String(error)}`;
			console.error(message);
		}
	};
	const approvedGuests = () =>
		activeGuestRegistry
			?.load()
			.entries.filter((entry) => entry.status === "approved")
			.map((entry) => ({
				guestName: entry.guestName,
				guestIdentity: entry.guestIdentity,
				callbackEndpoint: entry.callbackEndpoint,
			})) ?? [];
	const loadManifest = async (crewId: string) => {
		const runtime = state.guestMembershipRuntime;
		const membership = runtime?.list().find((row) => row.crew.id === crewId && row.status === "approved");
		const memberSocket = runtime?.getMemberSocket(crewId);
		if (!membership || !memberSocket) throw new Error(`No approved Guest membership for crew ${crewId}`);
		const manifestPath = getCrewManifestPathFromSocketPath(memberSocket);
		const projectRoot = path.resolve(path.dirname(manifestPath), "..", "..");
		const manifest = await readTrustedCrewManifest(
			manifestPath,
			projectRoot,
			() => state.context?.isProjectTrusted?.() === true,
		);
		if (!manifest.crew || manifest.crew.id !== crewId)
			throw new Error(`Crew manifest does not match selector ${crewId}`);
		const registry = createGuestRegistryStore({ manifestPath, crew: manifest.crew }).load();
		return {
			crew: manifest.crew,
			members: manifest.members,
			approvedGuests: registry.entries
				.filter((entry) => entry.status === "approved")
				.map((entry) => ({
					guestIdentity: entry.guestIdentity,
					guestName: entry.guestName,
					callbackEndpoint: entry.callbackEndpoint,
				})),
		};
	};
	let guestMessagingRegistered = false;
	const ensureMessagingTools = () => {
		if (
			guestMessagingRegistered ||
			state.guestMembershipRuntime?.list().some((row) => row.status === "approved") !== true
		)
			return;
		registerGuestMessagingTools(pi, state, {
			transport: { send: sendRpcCommand },
			loadManifest,
		});
		guestMessagingRegistered = true;
		reconcileGuestMessagingTools(pi, state);
	};
	const registerControlCommand = () => {
		registerGuestControlCommand(pi, state, {
			ensureControlServer: (api, currentState, ctx) => ensureControlServer(api, currentState, ctx),
			guestMembershipRuntime: state.guestMembershipRuntime,
			guestIdentity: (ctx) => ctx.sessionManager.getSessionId(),
			onMembershipChanged: ensureMessagingTools,
		});
	};
	return {
		refreshAdmission,
		approvedGuests,
		loadManifest,
		ensureMessagingTools,
		registerControlCommand,
	};
}
