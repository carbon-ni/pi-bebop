import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import {
	enqueueMemberInboxMessage,
	MemberInboxMessageError,
	type InboxHintTransport,
} from "../application/member-inbox-message.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import { actionableToolError, type ActionableToolResult } from "./actionable-tool-result.ts";

const parameters = Type.Object(
	{
		member: Type.String({ minLength: 1, description: "Crew member name or unique role" }),
		message: Type.String({ minLength: 1, description: "Message to persist in the member's inbox" }),
		instructions: MessagePayloadSchema.properties.instructions,
	},
	{ additionalProperties: false },
);
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

export interface SendToInboxDependencies {
	readonly isProjectTrusted?: () => boolean;
	readonly openStore?: typeof openTrustedMemberInboxStore;
	readonly hintTransport?: InboxHintTransport | null;
}

export function registerSendToInboxTool(
	pi: ExtensionAPI,
	state: SocketState,
	dependencies: SendToInboxDependencies = {},
): void {
	const isProjectTrusted = dependencies.isProjectTrusted ?? (() => state.context?.isProjectTrusted?.() === true);
	const openStore = dependencies.openStore ?? openTrustedMemberInboxStore;
	const hintTransport: InboxHintTransport =
		dependencies.hintTransport === undefined
			? {
					sendHint: async (endpoint, command, options) =>
						await sendRpcCommand(endpoint, command, { ...options, timeout: 1000 }),
				}
			: dependencies.hintTransport;

	pi.registerTool({
		name: "send_to_inbox",
		label: "Send To Inbox",
		description:
			"Persist a durable inbox message for a crew member. A best-effort hint may wake the recipient, but the item is offered only at the recipient's authoritative idle boundary as one normal Follow-up. Unlike send_follow_up or redirect_member, it survives recipient offline/restart. Success means persisted, never read or completed. Requires joined membership; the recipient may be offline.",
		parameters,
		async execute(_toolCallId, params) {
			const membership = state.membershipRuntime?.getMembership() ?? null;
			const target = params.member.trim();
			try {
				const outcome = await enqueueMemberInboxMessage(
					{
						membership: membership as never,
						member: target,
						message: params.message,
						instructions: params.instructions,
						now: Date.now(),
					},
					{
						isProjectTrusted,
						openStore: (options) =>
							openStore({
								manifestPath: options.manifestPath,
								projectRoot: options.projectRoot,
								isProjectTrusted: options.isProjectTrusted,
								member: options.member,
							}),
						hintTransport,
						resolveEndpoint: resolveMemberEndpoint,
					},
				);
				return {
					content: [
						{
							type: "text",
							text: `[${outcome.target.name} (${outcome.target.role})] Inbox item persisted (${outcome.itemId})${outcome.hint === "sent" ? "; recipient notified" : ""}`,
						},
					],
					details: {
						itemId: outcome.itemId,
						persisted: true,
						target: outcome.target.name,
						hint: outcome.hint,
					},
				} satisfies ToolResult;
			} catch (error) {
				if (error instanceof MemberInboxMessageError) return errorResult(target, error.code, error.message);
				const message = error instanceof Error ? error.message : "Inbox enqueue failed";
				return errorResult(target, "inbox-failed", message);
			}
		},
	});
}

function errorResult(target: string, code: string, _message: string): ActionableToolResult {
	return actionableToolError({
		code,
		operation: "send_to_inbox",
		reason: code === "not-joined" ? "Not joined to a crew" : "the inbox message could not be persisted",
		recovery: ["verify crew membership and the target, then retry the tool."],
		location: { kind: "member", name: "member", value: target },
	});
}
