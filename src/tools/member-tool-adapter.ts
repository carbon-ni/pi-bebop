import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	sendMemberMessage,
	type MemberDeliveryIntent,
	type MemberMessageDependencies,
	MemberMessageError,
} from "../application/member-message.ts";
import type { SocketState } from "../pi/control-runtime.ts";

const parameters = Type.Object({
	member: Type.String({ minLength: 1, description: "Crew member name or unique role" }),
	message: Type.String({ minLength: 1, description: "Message to send" }),
	wait_for: Type.Optional(Type.Union([Type.Literal("accepted"), Type.Literal("response")])),
});
const MAX_OUTPUT = 500;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

function resultText(target: string, outcome: { disposition: string }): ToolResult {
	return {
		content: [{ type: "text", text: `[${target}] Message accepted (${outcome.disposition})` }],
		details: outcome,
	};
}
function errorText(target: string, code: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: `[${target}] ${message.slice(0, MAX_OUTPUT)}` }],
		isError: true,
		details: { error: code },
	};
}

export interface MemberToolAdapterDependencies extends MemberMessageDependencies {}

export function registerMemberIntentTool(
	pi: ExtensionAPI,
	state: SocketState,
	intent: MemberDeliveryIntent,
	dependencies: MemberToolAdapterDependencies = {},
): void {
	const name = intent === "follow_up" ? "send_follow_up" : "send_immediate";
	const label = intent === "follow_up" ? "Send Follow-up" : "Send Immediate";
	const description =
		intent === "follow_up"
			? "Send a normal follow-up to a joined crew member; use this by default when urgency is not explicit."
			: "Send a message to redirect a crew member's active work; use only when changing what they are doing now.";
	pi.registerTool({
		name,
		label,
		description,
		parameters,
		async execute(_toolCallId, params, signal) {
			const membership = state.membershipRuntime?.getMembership() ?? null;
			const target = params.member.trim();
			const senderSessionId = state.context?.sessionManager.getSessionId();
			try {
				const outcome = await sendMemberMessage(
					{
						membership,
						member: target,
						message: params.message,
						intent,
						waitFor: params.wait_for,
						signal,
						sender: senderSessionId
							? {
									sessionId: senderSessionId,
									sessionName: state.context?.sessionManager.getSessionName()?.trim() || undefined,
								}
							: undefined,
					},
					dependencies,
				);
				return resultText(`${outcome.target.name} (${outcome.target.role})`, outcome);
			} catch (error) {
				if (error instanceof MemberMessageError)
					return errorText(target || "member", error.code, error.message);
				const message = error instanceof Error ? error.message : "Member endpoint offline";
				const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
				return errorText(
					target || "member",
					aborted ? "aborted" : "offline",
					aborted ? "Member request aborted" : `Member endpoint offline: ${message}`,
				);
			}
		},
	});
}
