import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import { BebopClientError, createInProcessFollowUpOperation, createInProcessRedirectOperation } from "../sdk/index.ts";
import type { MemberDeliveryIntent, MemberMessageDependencies } from "../application/member-message.ts";
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
	const surface = {
		getMembership: () => state.membershipRuntime?.getMembership() ?? null,
		isTrusted: () => state.context?.isProjectTrusted?.() === true,
		approvedGuests: () => dependencies.approvedGuests?.() ?? [],
		sender: () => {
			const sessionId = state.context?.sessionManager.getSessionId();
			return sessionId
				? {
						sessionId,
						sessionName: state.context?.sessionManager.getSessionName()?.trim() || undefined,
					}
				: undefined;
		},
	};
	const followUpOperation = createInProcessFollowUpOperation({ surface, message: dependencies });
	const redirectOperation = createInProcessRedirectOperation({ surface, message: dependencies });
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
			const target = params.member.trim();
			if (params.wait_for === "response")
				return errorText(
					target || "member",
					"response-wait-requires-member-request",
					"wait_for=response is unavailable on ordinary member messages; use send_member_request for a correlated Response",
				);
			try {
				const input = { message: params.message, instructions: params.instructions };
				const outcome =
					intent === "follow_up"
						? await followUpOperation.sendFollowUp(target, input, { signal })
						: await redirectOperation.redirectMember(target, input, { signal });
				return resultText(`${outcome.member.name} (${outcome.member.role})`, outcome);
			} catch (error) {
				if (error instanceof BebopClientError) {
					if (error.code === "aborted")
						return errorText(target || "member", "aborted", "Member request aborted");
					if (
						["offline-member", "offline-session", "unknown-session", "transport-error"].includes(error.code)
					)
						return errorText(target || "member", "offline", `Member endpoint offline: ${error.message}`);
					if (error.code === "malformed-response")
						return errorText(target || "member", "invalid-ack", error.message);
					if (error.code === "not-joined")
						return errorText(target || "member", "not-joined", "Not joined to a crew");
					return errorText(target || "member", error.code, error.message);
				}
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
