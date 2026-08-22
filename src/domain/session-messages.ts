import type { ExtractedMessage } from "./messages.ts";

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

function textContent(content: unknown): string {
	return (Array.isArray(content) ? content : [])
		.filter((part): part is TextPart => typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getLastAssistantMessage(branch: MessageEntry[]): ExtractedMessage | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "assistant") continue;
		const content = textContent(msg.content);
		if (!content) continue;
		return { role: "assistant", content, timestamp: msg.timestamp ?? 0 };
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
