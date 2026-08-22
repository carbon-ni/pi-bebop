import { isMessagePayload, type MessagePayload } from "./message-payload.ts";

/** Canonical model input. JSON escaping makes every field boundary unambiguous. */
export function renderMessagePayload(payload: MessagePayload): string {
	if (payload.origin === undefined && payload.instructions === undefined && payload.replyTo === undefined)
		return payload.content;
	return JSON.stringify({
		type: "message-context",
		content: payload.content,
		...(payload.instructions === undefined ? {} : { instructions: payload.instructions }),
		...(payload.origin === undefined ? {} : { origin: payload.origin }),
		...(payload.replyTo === undefined ? {} : { replyTo: payload.replyTo }),
	});
}

/** Parses the canonical model representation and proves field boundaries by schema validation. */
export function parseRenderedMessagePayload(rendered: string): MessagePayload {
	const value: unknown = JSON.parse(rendered);
	if (typeof value !== "object" || value === null || (value as { type?: unknown }).type !== "message-context")
		throw new Error("Invalid rendered message payload");
	const { type: _type, ...payload } = value as Record<string, unknown>;
	if (!isMessagePayload(payload)) throw new Error("Invalid rendered message payload");
	return payload;
}

/** UI-safe display text; callback routing is intentionally never displayed. */
export function renderMessagePayloadForDisplay(payload: MessagePayload): string {
	const sections: string[] = [];
	if (payload.origin) {
		sections.push(
			payload.origin.kind === "crew"
				? `Claimed origin: from ${payload.origin.name} (${payload.origin.role})`
				: `Claimed origin: from ${payload.origin.label}`,
		);
	}
	if (payload.instructions)
		sections.push(
			["Instructions:", ...payload.instructions.map((item, index) => `${index + 1}. ${item}`)].join("\n"),
		);
	sections.push(payload.content);
	return sections.join("\n\n");
}
