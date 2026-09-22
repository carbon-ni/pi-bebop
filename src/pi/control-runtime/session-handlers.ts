import { GUEST_CAPABILITIES, type RpcInboundCommand } from "../../domain/index.ts";
import { getCrewManifestPathFromSocketPath } from "../../infra/crew-manifest-store.ts";
import { readCurrentPiSessionEvidence } from "../session-capture.ts";
import type { CommandHandlerContext } from "./types.ts";

/** TASK-0201: purpose-specific private session metadata attestation. */
export async function handleSessionCapture(
	context: CommandHandlerContext,
	_command: Extract<RpcInboundCommand, { type: "session_capture" }>,
): Promise<void> {
	const { ctx, state, respond } = context;
	const membership = state.membershipRuntime?.getMembership();
	const guestView = state.guestMembershipRuntime?.list().find((item) => item.status === "approved");
	if (!membership && !guestView) {
		respond(false, "session_capture", undefined, "not-joined");
		return;
	}
	if (ctx.isProjectTrusted?.() !== true) {
		respond(false, "session_capture", undefined, "untrusted");
		return;
	}
	try {
		const session = readCurrentPiSessionEvidence(ctx);
		if (membership) {
			respond(true, "session_capture", {
				crewLocator: membership.manifestPath,
				crew: membership.manifest.crew
					? { id: membership.manifest.crew.id, displayName: membership.manifest.crew.displayName }
					: {},
				member: { name: membership.member.name, role: membership.member.role },
				session: {
					persisted: session.persisted,
					id: session.id,
					...(session.file === undefined ? {} : { file: session.file }),
					cwd: session.cwd,
					root: session.root,
				},
			});
			return;
		}
		const credentials = state.guestMembershipRuntime!.credentials(guestView!.crew.id);
		const memberSocket = state.guestMembershipRuntime!.getMemberSocket(guestView!.crew.id);
		if (!credentials || !memberSocket) {
			respond(false, "session_capture", undefined, "guest-route-unavailable");
			return;
		}
		respond(true, "session_capture", {
			crewLocator: getCrewManifestPathFromSocketPath(memberSocket),
			crew: guestView.crew,
			guest: {
				identity: credentials.guestIdentity,
				name: credentials.guestName,
				capabilities: [...GUEST_CAPABILITIES],
			},
			session: {
				persisted: session.persisted,
				id: session.id,
				...(session.file === undefined ? {} : { file: session.file }),
				cwd: session.cwd,
				root: session.root,
			},
		});
	} catch {
		respond(false, "session_capture", undefined, "session-evidence-unavailable");
	}
}
