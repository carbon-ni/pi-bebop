import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import {
	submitGuestBroadcast,
	submitGuestMessage,
	type GuestMessageDependencies,
	type GuestMessageRequest,
} from "../application/guest-message.ts";
import type { SocketState } from "../pi/control-runtime.ts";

export const GUEST_MESSAGING_TOOLS = ["guest_send", "guest_broadcast"] as const;

const sendParameters = Type.Object(
	{
		crew: Type.String({ minLength: 1, description: "Exact approved crew id; never inferred" }),
		target: Type.String({ minLength: 1, description: "Exact Member name or unique Member role" }),
		message: Type.String({ minLength: 1, description: "Message to send" }),
		instructions: MessagePayloadSchema.properties.instructions,
	},
	{ additionalProperties: false },
);
const broadcastParameters = Type.Object(
	{
		crew: Type.String({ minLength: 1, description: "Exact approved crew id; never inferred" }),
		message: Type.String({ minLength: 1, description: "Message to broadcast" }),
		instructions: MessagePayloadSchema.properties.instructions,
	},
	{ additionalProperties: false },
);
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

function errorResult(error: unknown): ToolResult {
	const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "error";
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : "Guest messaging failed" }],
		isError: true,
		details: { error: code },
	};
}

export interface GuestMessagingToolDependencies extends GuestMessageDependencies {
	readonly loadManifest: GuestMessageRequest["loadManifest"];
}

export function registerGuestMessagingTools(
	pi: ExtensionAPI,
	state: SocketState,
	dependencies: GuestMessagingToolDependencies,
): void {
	pi.registerTool({
		name: "guest_send",
		label: "Guest Send",
		description:
			"Send a direct, ordinary Follow-up as an approved Guest. Requires the exact crew selector on every call; target resolution stays inside that crew. Guest cannot use Inbox, Redirect, Interrupt, or Member administration.",
		parameters: sendParameters,
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const outcome = await submitGuestMessage(
					{
						guestRuntime: state.guestMembershipRuntime!,
						guestIdentity: "runtime-derived",
						crew: params.crew,
						target: params.target,
						message: params.message,
						instructions: params.instructions,
						loadManifest: dependencies.loadManifest,
						signal,
					},
					dependencies,
				);
				return {
					content: [
						{
							type: "text",
							text: `[${outcome.target.name} (${outcome.target.role})] Message accepted (${outcome.disposition})`,
						},
					],
					details: outcome,
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});
	pi.registerTool({
		name: "guest_broadcast",
		label: "Guest Broadcast",
		description:
			"Send one transient Broadcast Follow-up directly to every other approved participant in the exact selected crew. Reports each delivered/failed recipient; never persists or retries.",
		parameters: broadcastParameters,
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			try {
				const outcome = await submitGuestBroadcast(
					{
						guestRuntime: state.guestMembershipRuntime!,
						guestIdentity: "runtime-derived",
						crew: params.crew,
						message: params.message,
						instructions: params.instructions,
						loadManifest: dependencies.loadManifest,
						signal,
					},
					dependencies,
				);
				const failed = outcome.summary.failed;
				return {
					content: [
						{
							type: "text",
							text:
								failed === 0
									? `Delivered to ${outcome.summary.delivered} recipient${outcome.summary.delivered === 1 ? "" : "s"}`
									: `Delivered to ${outcome.summary.delivered} of ${outcome.summary.total} recipients (${failed} failed)`,
						},
					],
					isError: failed > 0,
					details: outcome,
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

export function reconcileGuestMessagingTools(pi: ExtensionAPI, state: SocketState): void {
	const approved = state.guestMembershipRuntime?.list().some((row) => row.status === "approved") === true;
	const active = pi
		.getActiveTools()
		.filter((name) => !GUEST_MESSAGING_TOOLS.includes(name as (typeof GUEST_MESSAGING_TOOLS)[number]));
	if (approved) pi.setActiveTools([...active, ...GUEST_MESSAGING_TOOLS]);
	else pi.setActiveTools(active);
}
