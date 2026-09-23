import type { ExtractedMessage } from "./messages.ts";
import { MAX_MESSAGE_CONTENT_BYTES } from "./message-payload.ts";

type TextPart = { type: "text"; text: string };
type MessageEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		timestamp?: number;
	};
};
type SessionEntry = { id?: string; parentId?: string | null };

export type LastAssistantMessageInspection =
	| { kind: "none" }
	| { kind: "message"; message: ExtractedMessage }
	| { kind: "malformed"; code: "malformed-response" | "message-too-large" };

function textContent(content: unknown): string {
	return (Array.isArray(content) ? content : [])
		.filter(
			(part): part is TextPart =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: string; text?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

export function inspectLastAssistantMessage(branch: MessageEntry[]): LastAssistantMessageInspection {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) return { kind: "malformed", code: "malformed-response" };
		const textParts = msg.content.filter(
			(part): part is { type: "text"; text: unknown } =>
				typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
		);
		if (textParts.length === 0) continue;
		if (textParts.some((part) => typeof part.text !== "string"))
			return { kind: "malformed", code: "malformed-response" };
		const content = textParts.map((part) => part.text).join("\n");
		if (!content) continue;
		if (!Number.isSafeInteger(msg.timestamp) || msg.timestamp < 0)
			return { kind: "malformed", code: "malformed-response" };
		if (Buffer.byteLength(content, "utf8") > MAX_MESSAGE_CONTENT_BYTES)
			return { kind: "malformed", code: "message-too-large" };
		return { kind: "message", message: { role: "assistant", content, timestamp: msg.timestamp } };
	}
	return { kind: "none" };
}

export function getLastAssistantMessage(branch: MessageEntry[]): ExtractedMessage | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "assistant") continue;
		const content = textContent(msg.content);
		if (!content || !Number.isSafeInteger(msg.timestamp) || msg.timestamp < 0) continue;
		return { role: "assistant", content, timestamp: msg.timestamp };
	}
	return undefined;
}

export function getMessagesSinceLastPrompt(branch: MessageEntry[]): ExtractedMessage[] {
	let lastUserIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message?.role === "user") {
			lastUserIndex = i;
			break;
		}
	}

	if (lastUserIndex === -1) return [];

	const messages: ExtractedMessage[] = [];
	for (let i = lastUserIndex; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
		const content = textContent(msg.content);
		if (!content) continue;
		messages.push({ role: msg.role, content, timestamp: msg.timestamp ?? 0 });
	}
	return messages;
}

export function getFirstEntryId(entries: SessionEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	const root = entries.find((entry) => entry.parentId === null);
	return root?.id ?? entries[0]?.id;
}
