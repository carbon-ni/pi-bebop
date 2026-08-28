import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import { submitCrewBroadcast } from "../application/crew-broadcast.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import { actionableToolError } from "./actionable-tool-result.ts";

/**
 * broadcast_to_crew — durable, non-interrupting fan-out to every other member.
 *
 * Internal, joined-members only: the tool is registered unconditionally but
 * only activated while joined (MEMBERSHIP_TOOLS in control-runtime), and the
 * application operation rejects without an active membership. No endpoint is
 * ever probed; every recipient gets an independent Inbox item replayed by the
 * normal TASK-0037 follow-up bridge. Never steers or redirects active work.
 */

const BROADCAST_ERROR_CODES = new Set(["no-recipients", "not-configured-member", "unexpected-failure"]);

function normalizeBroadcastErrorCode(code: string | undefined): string {
	return code && BROADCAST_ERROR_CODES.has(code) ? code : "unexpected-failure";
}

const parameters = Type.Object(
	{
		message: Type.String({ minLength: 1, description: "Message to broadcast to every other crew member" }),
		instructions: MessagePayloadSchema.properties.instructions,
	},
	{ additionalProperties: false },
);

// details is intentionally `unknown` so every tool branch can declare its own shape.
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

export function registerBroadcastToCrewTool(
	pi: ExtensionAPI,
	state: SocketState,
	dependencies: { isProjectTrusted: () => boolean },
): void {
	pi.registerTool({
		name: "broadcast_to_crew",
		label: "Broadcast To Crew",
		description:
			"Durably send one non-interrupting message to every other configured crew member, in manifest order, whether they are online or not. Each recipient later receives it as a normal follow-up; it never interrupts or redirects active work and the sender is excluded. Use for shared team-wide information (for example an API contract change or a global constraint), not for work that should have a single owner — for a targeted message use send_follow_up or send_to_inbox for the specific member instead. No live delivery or response is implied; if a recipient's inbox is full that recipient is reported as failed, and retrying the same broadcast is safe and idempotent.",
		parameters,
		async execute(_toolCallId, params): Promise<ToolResult> {
			const membership = (state.membershipRuntime?.getMembership() ?? null) as never;
			try {
				const result = await submitCrewBroadcast(
					{
						membership,
						message: params.message,
						instructions: params.instructions,
						now: Date.now(),
					},
					{
						isProjectTrusted: dependencies.isProjectTrusted,
						openStore: async (options) =>
							openTrustedMemberInboxStore({
								manifestPath: options.manifestPath,
								projectRoot: options.projectRoot,
								isProjectTrusted: options.isProjectTrusted,
								member: {
									name: options.member.name,
									role: options.member.role,
									socketPath: options.member.socketPath,
								},
							}),
					},
				);

				if (result.ok === false) {
					const message =
						result.code === "no-recipients"
							? "Nothing to broadcast: you are the only configured member"
							: "Cannot broadcast: sender is not a configured member";
					return actionableToolError(
						{
							code: normalizeBroadcastErrorCode(result.code),
							operation: "broadcast_to_crew",
							reason:
								result.code === "no-recipients"
									? "there are no other crew recipients"
									: "the sender is not a configured crew member",
							recovery: ["verify crew membership and retry the tool."],
						},
						{ broadcastId: result.broadcastId },
					);
				}

				const recipients = result.dispositions.map((disposition) => ({
					member: disposition.recipientName,
					role: disposition.recipientRole,
					itemId: disposition.itemId,
					disposition: disposition.status,
					...(disposition.code === undefined ? {} : { code: disposition.code }),
				}));

				const { persisted, alreadyPersisted, failed } = result.summary;
				if (failed > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Persisted for ${persisted} of ${result.summary.total} recipients (${failed} failed, ${alreadyPersisted} already persisted); retry is safe and will not duplicate.`,
							},
						],
						isError: true,
						details: { broadcastId: result.broadcastId, ...result.summary, recipients },
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Persisted for ${persisted} recipient${persisted === 1 ? "" : "s"}${
								alreadyPersisted > 0 ? ` (${alreadyPersisted} already persisted)` : ""
							}`,
						},
					],
					details: { broadcastId: result.broadcastId, ...result.summary, recipients },
				};
			} catch (error) {
				const code = normalizeBroadcastErrorCode(
					error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : undefined,
				);
				return actionableToolError({
					code,
					operation: "broadcast_to_crew",
					reason: "the broadcast could not be persisted",
					recovery: ["verify crew membership and retry the tool."],
				});
			}
		},
	});
}
