import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { isMessagePayload, renderMessagePayloadForDisplay, type MessagePayload } from "../domain/index.ts";

const SENDER_INFO_PATTERN = /<sender_info>[\s\S]*?<\/sender_info>/g;
const LEGACY_REPLY_INSTRUCTION_PATTERN =
	/<reply_instruction>When responding, reply directly to the sender by calling send_to_member with the sessionId from sender_info\. Do not use get_message polling\.<\/reply_instruction>/g;

function extractTextContent(content: string | Array<TextContent | { type: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

export function stripMessageMetadata(text: string): string {
	return text.replace(LEGACY_REPLY_INSTRUCTION_PATTERN, "").replace(SENDER_INFO_PATTERN, "").trim();
}

interface SenderInfo {
	sessionId?: string;
	sessionName?: string;
}

function payloadFromDetails(message: unknown): MessagePayload | null {
	const details = (message as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return null;
	const payload = (details as { messagePayload?: unknown }).messagePayload;
	return isMessagePayload(payload) ? payload : null;
}

function claimedOrigin(payload: MessagePayload): string | null {
	if (!payload.origin) return null;
	return payload.origin.kind === "crew"
		? `from ${payload.origin.name} (${payload.origin.role})`
		: `from ${payload.origin.label}`;
}

export function parseSenderInfo(text: string): SenderInfo | null {
	const match = text.match(/<sender_info>([\s\S]*?)<\/sender_info>/);
	if (!match) return null;
	const raw = match[1].trim();
	if (!raw) return null;

	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw) as { sessionId?: unknown; sessionName?: unknown };
			const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
			const sessionName = typeof parsed.sessionName === "string" ? parsed.sessionName.trim() : "";
			if (sessionId || sessionName) {
				return {
					sessionId: sessionId || undefined,
					sessionName: sessionName || undefined,
				};
			}
		} catch {
			// Ignore JSON parse errors, fall back to legacy parsing.
		}
	}

	const legacyIdMatch = raw.match(/session\s+([a-f0-9-]{6,})/i);
	if (legacyIdMatch) {
		return { sessionId: legacyIdMatch[1] };
	}

	return null;
}

function formatSenderInfo(info: SenderInfo | null): string | null {
	if (!info) return null;
	const { sessionName, sessionId } = info;
	if (sessionName && sessionId) return `${sessionName} (${sessionId})`;
	if (sessionName) return sessionName;
	if (sessionId) return sessionId;
	return null;
}

export function getMessageDisplayModel(
	message: unknown,
	expanded: boolean,
): { text: string; senderText: string | null } {
	const rawContent = extractTextContent(
		(message as { content: string | Array<TextContent | { type: string }> }).content,
	);
	const payload = payloadFromDetails(message);
	const senderInfo = payload ? null : parseSenderInfo(rawContent);
	let text = payload ? renderMessagePayloadForDisplay(payload) : stripMessageMetadata(rawContent);
	if (!text) text = "(no content)";
	if (!expanded) {
		const lines = text.split("\n");
		if (lines.length > 5) text = `${lines.slice(0, 5).join("\n")}\n...`;
	}
	return { text, senderText: payload ? claimedOrigin(payload) : formatSenderInfo(senderInfo) };
}

export const renderCrewPresence: MessageRenderer = (message, _options, theme) => {
	const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
	box.addChild(new Text(extractTextContent(message.content), 0, 0));
	return box;
};

export const renderCrewRoster: MessageRenderer = (message, _options, theme) => {
	const box = new Box(0, 0, (t) => theme.bg("customMessageBg", t));
	box.addChild(
		new Markdown(extractTextContent(message.content), 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);
	return box;
};

export const renderSessionMessage: MessageRenderer = (message, { expanded }, theme) => {
	const { text, senderText } = getMessageDisplayModel(message, expanded);

	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	const labelBase = theme.fg("customMessageLabel", `\x1b[1m[${message.customType}]\x1b[22m`);
	const label = senderText ? `${labelBase} ${theme.fg("dim", senderText)}` : labelBase;
	box.addChild(new Text(label, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(
		new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);
	return box;
};

export const renderCrewInterrupt: MessageRenderer = (message, { expanded }, theme) => {
	const { text, senderText } = getMessageDisplayModel(message, expanded);
	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	const labelBase = theme.fg("customMessageLabel", `\x1b[1m[interrupt]\x1b[22m`);
	const label = senderText ? `${labelBase} ${theme.fg("dim", senderText)}` : labelBase;
	box.addChild(new Text(label, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(
		new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);
	box.addChild(new Spacer(1));
	box.addChild(
		new Text(
			theme.fg("dim", "Note: prior side effects were NOT rolled back; verify state before continuing."),
			0,
			0,
		),
	);
	return box;
};
