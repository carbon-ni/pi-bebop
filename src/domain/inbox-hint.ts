import type { MessagePayload } from "./message-payload.ts";

/**
 * Best-effort inbox hint contract shared by the enqueue tool (sender) and the
 * inbox bridge (recipient). The hint is a normal follow-up message whose
 * content begins with a fixed prefix and names the durable item so the
 * recipient can trigger an offer attempt without any custom RPC surface.
 */

export const INBOX_HINT_PREFIX = "[inbox]";
const INBOX_HINT_MARKER = "durable inbox item";

export type InboxHintPayload = MessagePayload;

/** True when the payload looks like the canonical enqueue-time hint. */
export function isInboxHint(payload: MessagePayload): boolean {
	const content = payload.content.trimStart();
	return content.startsWith(INBOX_HINT_PREFIX) && content.includes(INBOX_HINT_MARKER);
}
