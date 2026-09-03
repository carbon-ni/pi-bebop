import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import { submitCrewBroadcast } from "../application/crew-broadcast.ts";
import type { BroadcastMessageDependencies } from "../application/crew-broadcast.ts";
import type { SocketState } from "../pi/control-runtime.ts";

/**
 * broadcast_to_crew — transient, non-interrupting Follow-up fan-out.
 *
 * Every other configured member is attempted in manifest order. The tool has
 * no Inbox fallback, delivery mode, redirect, interrupt, or response option.
 */

const parameters = Type.Object(
	{
		message: Type.String({ minLength: 1, description: "Message to broadcast to every other crew member" }),
		instructions: MessagePayloadSchema.properties.instructions,
	},
	{ additionalProperties: false },
);

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

export function registerBroadcastToCrewTool(
	pi: ExtensionAPI,
	state: SocketState,
	dependencies: BroadcastMessageDependencies,
): void {
	pi.registerTool({
		name: "broadcast_to_crew",
		label: "Broadcast To Crew",
		description:
			"Send one transient, non-interrupting Broadcast Follow-up to every other configured crew member in manifest order. Each recipient is attempted independently; offline or rejected recipients are reported as failed and do not stop later deliveries. The sender is excluded. Broadcast never writes or falls back to Inbox, redirects active work, interrupts, or expects a Response. Use send_to_inbox for durable delivery to one member.",
		parameters,
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			const membership = state.membershipRuntime?.getMembership() ?? null;
			try {
				const result = await submitCrewBroadcast(
					{
						membership,
						message: params.message,
						instructions: params.instructions,
						signal,
					},
					dependencies,
				);
				if (result.ok === false) {
					const message =
						result.code === "no-recipients"
							? "Nothing to broadcast: you are the only configured member"
							: "Cannot broadcast: sender is not a configured member";
					return { content: [{ type: "text", text: message }], isError: true, details: { error: result.code } };
				}
				const delivered = result.summary.delivered;
				const failed = result.summary.failed;
				const recipients = result.dispositions.map((disposition) => ({
					member: disposition.recipientName,
					role: disposition.recipientRole,
					disposition: disposition.disposition,
					...(disposition.deliveryId === undefined ? {} : { deliveryId: disposition.deliveryId }),
					...(disposition.code === undefined ? {} : { code: disposition.code }),
				}));
				return {
					content: [
						{
							type: "text",
							text:
								failed === 0
									? `Delivered to ${delivered} recipient${delivered === 1 ? "" : "s"}`
									: `Delivered to ${delivered} of ${result.summary.total} recipients (${failed} failed)`,
						},
					],
					isError: failed > 0,
					details: { ...result.summary, recipients },
				};
			} catch (error) {
				const code =
					error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "error";
				const message = error instanceof Error ? error.message : "Broadcast failed";
				return { content: [{ type: "text", text: message }], isError: true, details: { error: code } };
			}
		},
	});
}
