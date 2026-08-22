import type { WaitUntil } from "./cli.ts";

export type ReplyBehavior = "allow_reply" | "end_conversation";

export interface ResponsePolicy {
	waitUntil: WaitUntil;
	replyBehavior: ReplyBehavior;
	allowsReply: boolean;
}

export type ResponsePolicyResult = ResponsePolicy | { error: string };

const INCOMPATIBLE_MODE_ERROR =
	"turn_end cannot be combined with allow_reply; use message_processed or off for callback chat, or end_conversation for a synchronous response.";

export function resolveResponsePolicy(
	waitUntil: WaitUntil = "turn_end",
	replyBehavior?: ReplyBehavior,
): ResponsePolicyResult {
	const resolvedReplyBehavior = replyBehavior ?? (waitUntil === "turn_end" ? "end_conversation" : "allow_reply");

	if (waitUntil === "turn_end" && resolvedReplyBehavior === "allow_reply") {
		return { error: INCOMPATIBLE_MODE_ERROR };
	}

	return {
		waitUntil,
		replyBehavior: resolvedReplyBehavior,
		allowsReply: resolvedReplyBehavior === "allow_reply",
	};
}
