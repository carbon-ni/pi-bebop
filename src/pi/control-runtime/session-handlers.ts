import type { RpcInboundCommand } from "../../domain/index.ts";
import { readCurrentPiSessionEvidence } from "../session-capture.ts";
import type { CommandHandlerContext } from "./types.ts";

/** TASK-0201: purpose-specific private session metadata attestation. */
export async function handleSessionCapture(
	context: CommandHandlerContext,
	_command: Extract<RpcInboundCommand, { type: "session_capture" }>,
): Promise<void> {
	const { ctx, state, respond } = context;
	const membership = state.membershipRuntime?.getMembership();
	if (!membership) {
		respond(false, "session_capture", undefined, "not-joined");
		return;
	}
	if (ctx.isProjectTrusted?.() !== true) {
		respond(false, "session_capture", undefined, "untrusted");
		return;
	}
	try {
		const session = readCurrentPiSessionEvidence(ctx);
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
	} catch {
		respond(false, "session_capture", undefined, "session-evidence-unavailable");
	}
}
