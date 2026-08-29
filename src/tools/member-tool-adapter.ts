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
import { actionableToolError, type ActionableToolResult } from "./actionable-tool-result.ts";

const parameters = Type.Object(
	{
		member: Type.String({ minLength: 1, description: "Crew member name or unique role" }),
		message: Type.String({ minLength: 1, description: "Message to send" }),
		instructions: MessagePayloadSchema.properties.instructions,
		wait_for: Type.Optional(Type.Union([Type.Literal("accepted"), Type.Literal("response")])),
	},
	{ additionalProperties: false },
);
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

const DEFERRED_ACKNOWLEDGEMENT =
	"Accepted by the recipient system for queued delivery. This does not mean model delivery, reading, availability, completion, or response.";

function resultText(target: string, outcome: { disposition: string; deferred?: boolean }): ToolResult {
	return {
		content: [
			{
				type: "text",
				text:
					outcome.deferred === true
						? DEFERRED_ACKNOWLEDGEMENT
						: `[${target}] Message accepted (${outcome.disposition})`,
			},
		],
		details: outcome,
	};
}
const MEMBER_INTENT_ERROR_CODES = new Set([
	"unknown-member",
	"ambiguous-member",
	"self-send",
	"not-joined",
	"response-wait-requires-member-request",
	"invalid-payload",
	"offline",
	"remote-rejected",
	"invalid-ack",
	"outcome-unknown",
	"aborted",
]);

type MemberIntentErrorCode =
	| "unknown-member"
	| "ambiguous-member"
	| "self-send"
	| "not-joined"
	| "response-wait-requires-member-request"
	| "invalid-payload"
	| "offline"
	| "remote-rejected"
	| "invalid-ack"
	| "outcome-unknown"
	| "aborted"
	| "unexpected-failure";

function normalizeMemberIntentErrorCode(code: unknown): MemberIntentErrorCode {
	return typeof code === "string" && MEMBER_INTENT_ERROR_CODES.has(code)
		? (code as MemberIntentErrorCode)
		: "unexpected-failure";
}

function errorReason(code: MemberIntentErrorCode): string {
	switch (code) {
		case "ambiguous-member":
			return "Ambiguous member target";
		case "offline":
			return "offline target shutdown";
		case "response-wait-requires-member-request":
			return "response unavailable without a member request";
		case "self-send":
			return "the target is yourself";
		case "unknown-member":
			return "Unknown member target";
		case "not-joined":
			return "Not joined to a crew";
		case "aborted":
			return "the member message operation was aborted";
		case "unexpected-failure":
			return "the member message operation could not be completed";
		default:
			return "the member message operation was rejected";
	}
}

function errorText(
	target: string,
	code: MemberIntentErrorCode,
	operation: "send_follow_up" | "redirect_member",
): ActionableToolResult {
	return actionableToolError({
		code,
		operation,
		reason: errorReason(code),
		recovery: ["verify crew membership and the target, then retry the tool."],
		location: { kind: "member", name: "member", value: target },
	});
}

export interface MemberToolAdapterDependencies extends MemberMessageDependencies {}

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
			? "Send an ordinary informational Follow-up to a joined crew member; no correlated Response is expected. Never infer response causality from Follow-up arrival order — a queued Follow-up may predate newer coordination. Use send_member_request instead when you require exactly one answer, report, verdict, or evidence response."
			: "Insert a message into a crew member's active work to change what they are doing now; use only when redirecting active work.";
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
				return resultText(`${outcome.target.name} (${outcome.target.role})`, outcome);
			} catch (error) {
				if (error instanceof MemberMessageError) return errorText(target || "member", error.code, name);
				const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
				const rawCode =
					error instanceof Error && "code" in error ? (error as Error & { code?: unknown }).code : undefined;
				return errorText(
					target || "member",
					aborted ? "aborted" : normalizeMemberIntentErrorCode(rawCode),
					name,
				);
			}
		},
	});
}
