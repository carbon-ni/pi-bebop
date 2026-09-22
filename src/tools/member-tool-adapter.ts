import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import {
	sendMemberMessage,
	type MemberDeliveryIntent,
	type MemberMessageDependencies,
	MemberMessageError,
} from "../application/member-message.ts";
import type { SocketState } from "../pi/control-runtime.ts";

const parameters = Type.Object(
	{
		member: Type.String({ minLength: 1, description: "Crew member name or unique role" }),
		message: Type.String({ minLength: 1, description: "Message to send" }),
		instructions: MessagePayloadSchema.properties.instructions,
		wait_for: Type.Optional(Type.Union([Type.Literal("accepted"), Type.Literal("response")])),
	},
	{ additionalProperties: false },
);
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

export interface MemberToolAdapterDependencies extends MemberMessageDependencies {
	/** Fresh crew-registry read of approved Guests, for Member->Guest addressing. */
	readonly approvedGuests?: () => readonly {
		readonly guestName: string;
		readonly guestIdentity: string;
		readonly callbackEndpoint: string;
	}[];
}

export function registerMemberIntentTool(
	pi: ExtensionAPI,
	state: SocketState,
	intent: MemberDeliveryIntent,
	dependencies: MemberToolAdapterDependencies,
): void {
	const name = intent === "follow_up" ? "send_follow_up" : "redirect_member";
	const label = intent === "follow_up" ? "Send Follow-up" : "Redirect Member";
	const description =
		intent === "follow_up"
			? "Send a non-interrupting informational Follow-up to a joined crew member. It reaches Pi as triggerTurn=true with deliverAs=followUp and waits behind streaming, tool execution, and compaction. Accepted means queued or submitted only; no correlated Response is expected. Use send_member_request when you require exactly one answer, report, verdict, or evidence response."
			: "Send an urgent Redirect into a joined crew member's active work as deliverAs=steer. It changes the next response step but does not hard-abort current work; use interrupt_member only for emergency recovery.";
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
						approvedGuests: dependencies.approvedGuests?.(),
						message: params.message,
						instructions: params.instructions,
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
				const label =
					outcome.target.kind === "member"
						? `${outcome.target.name} (${outcome.target.role})`
						: `${outcome.target.guestName} (guest)`;
				return resultText(label, outcome);
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
