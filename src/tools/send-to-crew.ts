import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import { createCallerConsentManifestLoader } from "../infra/crew-intake-reader.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import { sendCrewCorrespondence, type CrewCorrespondenceDependencies } from "../application/crew-correspondence.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import { actionableToolError, type ActionableToolResult } from "./actionable-tool-result.ts";

/**
 * send_to_crew — one durable Crew Correspondence to another local crew's
 * configured intake contact (TASK-0136).
 *
 * Joined-members only: source Member origin, crew label, and canonical source
 * manifest path are derived from active Membership at execute time; the tool
 * input cannot forge either. Delivery reuses the external-intake persistence
 * seam; success means persisted only — no probe, notification, acknowledgement,
 * or promised response. The structured Crew Return Address in the payload is
 * the reply affordance: the receiver replies by one explicit send_to_crew
 * invocation with that path as the target.
 */

const parameters = Type.Object(
	{
		manifestPath: Type.String({
			minLength: 1,
			description:
				"Absolute path to the target crew manifest (.pi/bebop/crew.json or .pi/crew/crew.json); for a reply, use the claimed crew return address you received",
		}),
		message: Type.String({ minLength: 1, description: "Message to persist for the target crew's contact" }),
		instructions: MessagePayloadSchema.properties.instructions,
	},
	{ additionalProperties: false },
);
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

export interface SendToCrewDependencies extends Partial<CrewCorrespondenceDependencies> {}

export function registerSendToCrewTool(
	pi: ExtensionAPI,
	state: SocketState,
	dependencies: SendToCrewDependencies = {},
): void {
	const loadManifest = dependencies.loadManifest ?? createCallerConsentManifestLoader();
	const openStore =
		dependencies.openStore ??
		(async (options: Parameters<typeof openTrustedMemberInboxStore>[0]) =>
			await openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true }));

	pi.registerTool({
		name: "send_to_crew",
		label: "Send To Crew",
		description:
			"Send one durable Crew Correspondence to the intake contact of another local crew, given its absolute manifest path. Source identity and the structured Crew Return Address are derived from your current membership and cannot be provided as input. The message is persisted for the target contact and may be read later even if they are offline; success means persisted only — never delivered, acknowledged, or answered. Reply by calling send_to_crew with the claimed crew return address you received; each turn is a new one-way message.",
		parameters,
		async execute(_toolCallId, params) {
			const target = params.manifestPath.trim();
			try {
				const outcome = await sendCrewCorrespondence(
					{
						membership: (state.membershipRuntime?.getMembership() ?? null) as never,
						targetManifestPath: target,
						message: params.message,
						instructions: params.instructions,
						now: Date.now(),
					},
					{ loadManifest, openStore },
				);
				return {
					content: [
						{
							type: "text",
							text: `Crew correspondence persisted for ${outcome.contact} (${outcome.contactRole}) at ${outcome.targetManifestPath} — inbox item ${outcome.itemId}; reply only via an explicit send_to_crew invocation`,
						},
					],
					details: {
						itemId: outcome.itemId,
						persisted: true,
						contact: outcome.contact,
						contactRole: outcome.contactRole,
						targetManifestPath: outcome.targetManifestPath,
					},
				} satisfies ToolResult;
			} catch (error) {
				const code = (error as { code?: string })?.code ?? "unexpected-failure";
				const reason =
					code === "not-joined"
						? "Not joined to a crew"
						: code === "self-target"
							? "the target crew is your own crew"
							: code === "non-absolute-target"
								? "the target manifest path is not a canonical absolute path"
								: "the crew correspondence could not be persisted";
				return errorResult(target || "manifestPath", code, reason);
			}
		},
	});
}

function errorResult(target: string, code: string, reason: string): ActionableToolResult {
	return actionableToolError({
		code,
		operation: "send_to_crew",
		reason,
		recovery: [
			"verify the absolute target crew manifest path (.pi/bebop/crew.json or .pi/crew/crew.json) and your joined membership, then retry the tool.",
		],
		location: { kind: "member", name: "manifestPath", value: target },
	});
}
