import { isMessagePayload, renderQueuedFollowUpModelContent, SESSION_MESSAGE_TYPE } from "../domain/index.ts";
import type { SocketState } from "./control-runtime.ts";

/**
 * TASK-0139 message_end handoff seam (pure adapter over SocketState).
 *
 * Pi emits `message_end` for a queued follow-up custom message at the
 * moment it is handed to the model — before it enters agent state or the
 * session log. Returning a replacement here rewrites exactly that message
 * once, in place, with the immutable target-observed queue provenance.
 *
 * Anything without a pending busy acceptance (direct, steered, historical,
 * foreign, malformed) is left byte-identical: returning undefined keeps
 * the original message untouched.
 */
export function handleMessageEndQueuedFollowUp(
	state: SocketState,
	message: unknown,
):
	| {
			role: "custom";
			customType: string;
			content: string;
			display: boolean;
			details: Record<string, unknown>;
			timestamp: number;
	  }
	| undefined {
	const record = message as {
		role?: unknown;
		customType?: unknown;
		content?: unknown;
		display?: unknown;
		details?: unknown;
		timestamp?: unknown;
	} | null;
	if (!record || record.role !== "custom" || record.customType !== SESSION_MESSAGE_TYPE) return undefined;
	if (typeof record.content !== "string") return undefined;
	const details = record.details;
	if (typeof details !== "object" || details === null) return undefined;
	const detailsRecord = details as Record<string, unknown>;
	if (detailsRecord.deliveryProvenance !== undefined) return undefined;
	const deliveryId = detailsRecord.deliveryId;
	if (typeof deliveryId !== "string" || deliveryId.length === 0) return undefined;
	const payload = detailsRecord.messagePayload;
	if (!isMessagePayload(payload)) return undefined;
	const provenance = state.queuedFollowUps.claimHandoff(deliveryId);
	if (!provenance) return undefined;
	return {
		role: "custom",
		customType: SESSION_MESSAGE_TYPE,
		content: renderQueuedFollowUpModelContent(payload, provenance),
		display: typeof record.display === "boolean" ? record.display : true,
		details: { ...detailsRecord, deliveryProvenance: provenance },
		timestamp: typeof record.timestamp === "number" ? record.timestamp : 0,
	};
}

/** Extension `message_end` adapter: wraps a replacement into Pi's result envelope. */
export function queuedFollowUpMessageEndResult(
	state: SocketState,
	message: unknown,
): { message: NonNullable<ReturnType<typeof handleMessageEndQueuedFollowUp>> } | undefined {
	const replacement = handleMessageEndQueuedFollowUp(state, message);
	return replacement === undefined ? undefined : { message: replacement };
}
