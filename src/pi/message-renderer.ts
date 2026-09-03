import type { EntryRenderer, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	elapsedMessageMilliseconds,
	formatMessageAge,
	isMessagePayload,
	renderMessagePayloadForDisplay,
	type MessagePayload,
} from "../domain/index.ts";

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

function detailsFromMessage(
	message: unknown,
): { payload: MessagePayload; sentAt?: number; deliveredAt?: number; kind?: string } | null {
	const details = (message as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return null;
	const candidate = details as { messagePayload?: unknown; sentAt?: unknown; deliveredAt?: unknown; inbox?: unknown };
	if (!isMessagePayload(candidate.messagePayload)) return null;
	return {
		payload: candidate.messagePayload,
		sentAt: typeof candidate.sentAt === "number" ? candidate.sentAt : candidate.messagePayload.sentAt,
		deliveredAt: typeof candidate.deliveredAt === "number" ? candidate.deliveredAt : undefined,
		kind: candidate.inbox && typeof candidate.inbox === "object" ? "inbox" : candidate.messagePayload.kind,
	};
}

function claimedOrigin(payload: MessagePayload): string | null {
	if (!payload.origin) return null;
	return payload.origin.kind === "crew"
		? `from ${payload.origin.name} (${payload.origin.role})`
		: `from ${payload.origin.label} (unverified)`;
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
): { text: string; senderText: string | null; timingText: string | null } {
	const rawContent = extractTextContent(
		(message as { content: string | Array<TextContent | { type: string }> }).content,
	);
	const typedDetails = detailsFromMessage(message);
	const payload = typedDetails?.payload ?? null;
	const senderInfo = payload ? null : parseSenderInfo(rawContent);
	let text = payload ? renderMessagePayloadForDisplay(payload) : stripMessageMetadata(rawContent);
	const timingText =
		payload && typedDetails?.deliveredAt !== undefined
			? typedDetails.kind === "member response"
				? `request age ${formatMessageAge(typedDetails.sentAt === undefined ? -1 : (elapsedMessageMilliseconds(typedDetails.sentAt, typedDetails.deliveredAt) ?? -1))}`
				: `age at delivery ${formatMessageAge(typedDetails.sentAt === undefined ? -1 : (elapsedMessageMilliseconds(typedDetails.sentAt, typedDetails.deliveredAt) ?? -1))}`
			: null;
	if (!text) text = "(no content)";
	if (!expanded) {
		const lines = text.split("\n");
		if (lines.length > 5) text = `${lines.slice(0, 5).join("\n")}\n...`;
	}
	return { text, senderText: payload ? claimedOrigin(payload) : formatSenderInfo(senderInfo), timingText };
}

export const renderCrewPresence: MessageRenderer = (message, _options, theme) => {
	const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
	box.addChild(new Text(extractTextContent(message.content), 0, 0));
	return box;
};

function contentOfEntry(entry: { data?: unknown }): string {
	const data = entry.data;
	if (data && typeof data === "object" && typeof (data as { content?: unknown }).content === "string")
		return (data as { content: string }).content;
	return typeof data === "string" ? data : "";
}

const markdownEntry = (content: string, theme: Parameters<EntryRenderer>[2]): ReturnType<EntryRenderer> => {
	const box = new Box(0, 0, (t) => theme.bg("customMessageBg", t));
	box.addChild(
		new Markdown(content, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);
	return box;
};

/** TUI-only crew roster entry: durable, never part of LLM context. */
export const renderCrewRosterEntry: EntryRenderer = (entry, _options, theme) =>
	markdownEntry(contentOfEntry(entry), theme);

/** TUI-only crew status entry: durable, never part of LLM context. */
export const renderCrewStatusEntry: EntryRenderer = (entry, _options, theme) =>
	markdownEntry(contentOfEntry(entry), theme);

/** TUI-only crew inbox entry: durable, never part of LLM context. */
export const renderCrewInboxEntry: EntryRenderer = (entry, _options, theme) =>
	markdownEntry(contentOfEntry(entry), theme);

export const renderSessionMessage: MessageRenderer = (message, { expanded }, theme) => {
	const { text, senderText, timingText } = getMessageDisplayModel(message, expanded);

	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	const labelBase = theme.fg("customMessageLabel", `\x1b[1m${sessionMessageLabel(message)}\x1b[22m`);
	const label = [senderText, timingText].filter(Boolean).length
		? `${labelBase} ${theme.fg("dim", [senderText, timingText].filter(Boolean).join(" · "))}`
		: labelBase;
	box.addChild(new Text(label, 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(
		new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);
	const hint = sessionMessageHint(message);
	if (hint) {
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("dim", hint), 0, 0));
	}
	return box;
};

export type SessionMessageKind =
	| "member-request"
	| "follow-up"
	| "redirect"
	| "interrupt"
	| "inbox"
	| "broadcast"
	| "external-intake"
	| "member-response"
	| "other";

/**
 * TASK-0076: structural UI distinction between an inbound Member request and
 * an ordinary Follow-up, derived from message details (never from content
 * heuristics). Bounded to semantic intent + opaque Request ID; callback
 * routes stay hidden.
 */
export function sessionMessageKind(message: unknown): SessionMessageKind {
	const details = (message as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return "other";
	if (typeof (details as { crewRequestId?: unknown }).crewRequestId === "string") return "member-request";
	const payload = (details as { messagePayload?: unknown }).messagePayload;
	if (payload && isMessagePayload(payload)) {
		switch (payload.kind) {
			case "redirect":
				return "redirect";
			case "interrupt":
				return "interrupt";
			case "inbox":
				return "inbox";
			case "broadcast":
				return "broadcast";
			case "external intake":
				return "external-intake";
			case "member response":
				return "member-response";
			default:
				return "follow-up";
		}
	}
	if ((details as { inbox?: unknown }).inbox !== undefined) return "inbox";
	if ((details as { messagePayload?: unknown }).messagePayload !== undefined) return "follow-up";
	return "other";
}

export function sessionMessageLabel(message: unknown): string {
	const kind = sessionMessageKind(message);
	if (kind === "member-request") return "[member request]";
	if (kind === "member-response") return "[member response]";
	if (kind === "follow-up") return "[follow-up]";
	if (kind === "redirect") return "[redirect]";
	if (kind === "interrupt") return "[interrupt]";
	if (kind === "inbox") return "[inbox]";
	if (kind === "broadcast") return "[broadcast]";
	if (kind === "external-intake") return "[external intake]";
	const customType = (message as { customType?: unknown }).customType;
	return typeof customType === "string" && customType ? `[${customType}]` : "[message]";
}

export function sessionMessageHint(message: unknown): string | null {
	const kind = sessionMessageKind(message);
	if (kind === "member-request") return "Respond with respond_to_member_request after completing the requested work.";
	return null;
}

export const renderCrewInterrupt: MessageRenderer = (message, { expanded }, theme) => {
	const { text, senderText, timingText } = getMessageDisplayModel(message, expanded);
	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	const labelBase = theme.fg("customMessageLabel", `\x1b[1m[interrupt]\x1b[22m`);
	const label = [senderText, timingText].filter(Boolean).length
		? `${labelBase} ${theme.fg("dim", [senderText, timingText].filter(Boolean).join(" · "))}`
		: labelBase;
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
