import { isMessagePayload, type MessagePayload } from "./message-payload.ts";
import { elapsedMessageMilliseconds, formatMessageHeader, type MessageKind } from "./message-age.ts";

/** Canonical model input. JSON escaping makes every field boundary unambiguous. */
export function renderMessagePayload(payload: MessagePayload): string {
	const { kind: _kind, sentAt: _sentAt, ...visiblePayload } = payload;
	if (
		visiblePayload.origin === undefined &&
		visiblePayload.instructions === undefined &&
		visiblePayload.replyTo === undefined
	)
		return visiblePayload.content;
	return JSON.stringify({
		type: "message-context",
		content: visiblePayload.content,
		...(visiblePayload.instructions === undefined ? {} : { instructions: visiblePayload.instructions }),
		...(visiblePayload.origin === undefined ? {} : { origin: visiblePayload.origin }),
		...(visiblePayload.replyTo === undefined ? {} : { replyTo: visiblePayload.replyTo }),
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

/** Adds the typed provenance/timing header without exposing transport metadata. */
export function renderModelMessageWithHeader(
	payload: MessagePayload,
	input: {
		readonly kind: MessageKind;
		readonly sentAt?: number;
		readonly deliveredAt: number;
		readonly requestId?: string;
	},
): string {
	const elapsedMs =
		input.sentAt === undefined
			? undefined
			: (elapsedMessageMilliseconds(input.sentAt, input.deliveredAt) ?? undefined);
	return `${formatMessageHeader({
		kind: input.kind,
		origin: payload.origin,
		elapsedMs,
		requestId: input.requestId,
	})}\n${renderMessagePayload(payload)}`;
}

/**
 * TASK-0076: bounded structural marker prepended to the model-visible content
 * of an inbound Member request. Carries semantic intent + the opaque Request
 * ID only — never the requester socket/session/manifest path or any
 * authentication claim. The canonical payload JSON follows on the next line.
 */
export function renderMemberRequestModelContent(
	payload: MessagePayload,
	requestId: string,
	deliveredAt?: number,
): string {
	const header =
		deliveredAt === undefined
			? ""
			: `${formatMessageHeader({
					kind: "member request",
					origin: payload.origin,
					elapsedMs:
						payload.sentAt === undefined
							? undefined
							: (elapsedMessageMilliseconds(payload.sentAt, deliveredAt) ?? -1),
					requestId,
				})}\n`;
	return `${header}[member request] ${requestId}: do the requested work, then respond with respond_to_member_request. Never wait with wait_for_request_outcome for this inbound request.\n${renderMessagePayload(payload)}`;
}

/**
 * TASK-0076: bounded structural marker for ordinary Follow-up — information
 * only, no correlated Response expected. Message content is never parsed or
 * heuristically upgraded into a Member request.
 */
export function renderFollowUpModelContent(payload: MessagePayload, deliveredAt?: number): string {
	const header =
		deliveredAt === undefined
			? ""
			: `${formatMessageHeader({
					kind: payload.kind === "redirect" ? "redirect" : "follow-up",
					origin: payload.origin,
					elapsedMs:
						payload.sentAt === undefined
							? undefined
							: (elapsedMessageMilliseconds(payload.sentAt, deliveredAt) ?? -1),
				})}\n`;
	return `${header}[${payload.kind === "redirect" ? "redirect" : "follow-up"}] information only; no correlated Response expected.\n${renderMessagePayload(payload)}`;
}
