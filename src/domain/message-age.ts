/** A clock seam used by message composition; callers own when to capture each instant. */
export interface MessageClock {
	readonly now: () => number;
}

/** Model-visible fallback for missing, malformed, future, or overflowing timing. */
export const UNAVAILABLE_MESSAGE_AGE = "unavailable";

import type { MessageKind, MessageOrigin } from "./message-payload.ts";
import { MESSAGE_KINDS } from "./message-payload.ts";
export { MESSAGE_KINDS } from "./message-payload.ts";
export type { MessageKind } from "./message-payload.ts";

export interface MessageHeaderInput {
	readonly kind: MessageKind;
	readonly origin?: MessageOrigin;
	readonly elapsedMs?: number;
	readonly requestId?: string;
}

const isEpochMilliseconds = (value: number): boolean =>
	Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/**
 * Computes a frozen nonnegative elapsed duration from two validated epoch
 * millisecond instants. Invalid or future timestamps are intentionally not
 * clamped: callers must show unavailable rather than misleading zero age.
 */
export function elapsedMessageMilliseconds(sentAt: number, deliveredAt: number): number | null {
	if (!isEpochMilliseconds(sentAt) || !isEpochMilliseconds(deliveredAt) || deliveredAt < sentAt) return null;
	const elapsed = deliveredAt - sentAt;
	return Number.isSafeInteger(elapsed) ? elapsed : null;
}

/** Formats a frozen elapsed duration without consulting the current clock. */
export function formatMessageAge(elapsedMs: number): string {
	if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) return UNAVAILABLE_MESSAGE_AGE;
	if (elapsedMs < 1_000) return "<1s";
	const seconds = Math.floor(elapsedMs / 1_000);
	if (elapsedMs < 60_000) return `${seconds}s`;
	const minutes = Math.floor(elapsedMs / 60_000);
	if (elapsedMs < 3_600_000) return `${minutes}m`;
	const hours = Math.floor(elapsedMs / 3_600_000);
	if (elapsedMs < 86_400_000) return `${hours}h ${minutes % 60}m`;
	const days = Math.floor(elapsedMs / 86_400_000);
	return `${days}d ${hours % 24}h`;
}

/** Formats age directly from sent/delivered instants with safe invalid handling. */
export function formatMessageAgeBetween(sentAt: number, deliveredAt: number): string {
	const elapsed = elapsedMessageMilliseconds(sentAt, deliveredAt);
	return elapsed === null ? UNAVAILABLE_MESSAGE_AGE : formatMessageAge(elapsed);
}

function formatHeaderOrigin(origin: MessageHeaderInput["origin"]): string {
	if (!origin) return "from unknown";
	if (origin.kind === "crew") return `from ${origin.name} (${origin.role})`;
	if (origin.kind === "guest") return `from ${origin.name} (guest)`;
	return `from ${origin.label} (unverified)`;
}

/** Formats the compact, model-visible provenance and timing header. */
export function formatMessageHeader(input: MessageHeaderInput): string {
	const age = formatMessageAge(input.elapsedMs ?? -1);
	const timing = input.kind === "member response" ? `request age ${age}` : `age at delivery ${age}`;
	const request =
		(input.kind === "member request" || input.kind === "member response") && input.requestId
			? ` · request ${input.requestId}`
			: "";
	return `[${input.kind}] ${formatHeaderOrigin(input.origin)} · ${timing}${request}`;
}
