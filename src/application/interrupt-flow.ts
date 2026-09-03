import {
	elapsedMessageMilliseconds,
	formatMessageHeader,
	isMessagePayload,
	type MessagePayload,
} from "../domain/index.ts";

/**
 * Target-owned interrupt state machine (application, TASK-0045).
 *
 * This is the server side of `message.interrupt`: one operation owns the
 * strict sequence so there is no client `abort` + `send` race.
 *
 *   pending evidence persisted  ->  abort requested (busy only)  ->
 *   recovery message handed to Pi  ->  handed-off evidence persisted
 *
 * The Pi lifecycle sequence is the TASK-0044 characterization: on abort the
 * run emits `agent_end`, awaits listeners, then the agent loop drains the
 * steering queue BEFORE follow-ups. So the recovery message is delivered with
 * `deliverAs: "steer"` (busy) or a direct turn (idle) and becomes the next
 * model-visible guidance ahead of older queued follow-ups.
 *
 * Transport-only: this never claims to roll back side effects, never clears
 * the session, and never exposes a reply route. Abort is best-effort for
 * abort-aware work only.
 *
 * The Pi surface is injected so the state machine stays free of Pi types:
 * `isIdle`, `abort`, `sendMessage`, `appendEntry`, `getEntries`.
 */

export const INTERRUPT_ENTRY_TYPE = "intray-interrupt";
const MAX_INTERRUPT_EVIDENCE_BYTES = 1024;

export type InterruptFlowErrorCode =
	| "invalid-payload"
	| "already-pending"
	| "abort-failed"
	| "no-context"
	| "handoff-failed";

export class InterruptFlowError extends Error {
	readonly code: InterruptFlowErrorCode;

	constructor(code: InterruptFlowErrorCode, message: string) {
		super(message);
		this.name = "InterruptFlowError";
		this.code = code;
	}
}

export type InterruptFlowOutcome =
	| {
			readonly ok: true;
			readonly interruptId: string;
			readonly disposition: "interrupt-requested" | "direct";
	  }
	| { readonly ok: false; readonly code: InterruptFlowErrorCode };

export interface InterruptPiSurface {
	readonly isIdle: () => boolean;
	readonly abort: () => void | Promise<void>;
	readonly sendMessage: (message: unknown, options?: unknown) => Promise<void> | void;
	readonly appendEntry: (customType: string, data?: unknown) => void;
	readonly getEntries: () => readonly unknown[];
	/** Recipient-owned clock captured at Pi handoff. */
	readonly now?: () => number;
}

export interface InterruptEvidenceRecord {
	readonly phase: "pending" | "handed-off";
	readonly interruptId: string;
	readonly targetName: string;
	readonly senderName: string;
	readonly abortRequested: boolean;
	readonly deliveredAt?: number;
	readonly sentAt?: number;
	readonly content?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeText(value: unknown, maxBytes = MAX_INTERRUPT_EVIDENCE_BYTES): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		!value.includes("\0") &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

/** Scan entries (newest first) for the latest interrupt evidence record per interrupt id. */
export function latestInterruptEvidence(entries: readonly unknown[]): InterruptEvidenceRecord | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== INTERRUPT_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const data = entry.data;
		if (data.phase !== "pending" && data.phase !== "handed-off") continue;
		if (!isSafeText(data.interruptId) || !isSafeText(data.targetName) || !isSafeText(data.senderName)) continue;
		if (typeof data.abortRequested !== "boolean") continue;
		const deliveredAt: number | undefined =
			data.deliveredAt === undefined
				? undefined
				: typeof data.deliveredAt === "number" && Number.isFinite(data.deliveredAt)
					? data.deliveredAt
					: undefined;
		const sentAt: number | undefined =
			data.sentAt === undefined
				? undefined
				: typeof data.sentAt === "number" && Number.isSafeInteger(data.sentAt) && data.sentAt >= 0
					? data.sentAt
					: undefined;
		if (data.deliveredAt !== undefined && deliveredAt === undefined) continue;
		if (data.sentAt !== undefined && sentAt === undefined) continue;
		return {
			phase: data.phase as InterruptEvidenceRecord["phase"],
			interruptId: data.interruptId,
			targetName: data.targetName,
			senderName: data.senderName,
			abortRequested: data.abortRequested,
			...(deliveredAt === undefined ? {} : { deliveredAt }),
			...(sentAt === undefined ? {} : { sentAt }),
		};
	}
	return null;
}

/** True when there is a pending (not yet handed-off) interrupt for the given target. */
export function hasPendingInterrupt(entries: readonly unknown[], targetName: string): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== INTERRUPT_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const data = entry.data;
		if (data.targetName !== targetName) continue;
		if (data.phase === "handed-off") return false;
		if (data.phase === "pending") return true;
	}
	return false;
}

function evidenceRecord(
	phase: "pending" | "handed-off",
	evidence: Omit<InterruptEvidenceRecord, "phase">,
): InterruptEvidenceRecord {
	const deliveredAt = evidence.deliveredAt;
	const content = evidence.content;
	const sentAt = evidence.sentAt;
	return {
		phase,
		interruptId: evidence.interruptId,
		targetName: evidence.targetName,
		senderName: evidence.senderName,
		abortRequested: evidence.abortRequested,
		...(deliveredAt === undefined ? {} : { deliveredAt }),
		...(sentAt === undefined ? {} : { sentAt }),
		...(content === undefined ? {} : { content }),
	};
}

export function createInterruptFlow(surface: InterruptPiSurface) {
	const persist = (record: InterruptEvidenceRecord): void => {
		surface.appendEntry(INTERRUPT_ENTRY_TYPE, record);
	};

	const interrupt = async (payload: MessagePayload): Promise<InterruptFlowOutcome> => {
		if (!isMessagePayload(payload)) return { ok: false, code: "invalid-payload" };

		const origin = payload.origin;
		if (!origin || origin.kind !== "crew") return { ok: false, code: "invalid-payload" };

		const targetName = origin.name;
		const entries = surface.getEntries();
		if (hasPendingInterrupt(entries, targetName)) return { ok: false, code: "already-pending" };

		const senderName = payload.origin.kind === "crew" ? payload.origin.name : "external";
		const interruptId = `interrupt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		const abortRequested = !surface.isIdle();

		// 1. Persist pending evidence BEFORE any abort (crash-safe: reload sees pending-without-handed-off).
		persist(
			evidenceRecord("pending", {
				interruptId,
				targetName,
				senderName,
				abortRequested,
				sentAt: payload.sentAt,
				content: payload.content,
			}),
		);

		try {
			if (abortRequested) {
				// 2. Abort the active run. Pi emits agent_end and awaits listeners; steering survives.
				await surface.abort();
			}
			// 3. Hand recovery to Pi: steer (busy) precedes older follow-ups; direct turn when idle.
			const deliveredAt = surface.now?.();
			await surface.sendMessage(
				{
					customType: "crew-interrupt",
					content:
						deliveredAt === undefined
							? `[interrupt] ${payload.content}`
							: `${formatMessageHeader({
									kind: "interrupt",
									origin: payload.origin,
									elapsedMs:
										payload.sentAt === undefined
											? undefined
											: (elapsedMessageMilliseconds(payload.sentAt, deliveredAt) ?? undefined),
								})}\n${payload.content}`,
					display: true,
					details: { messagePayload: payload, ...(deliveredAt === undefined ? {} : { deliveredAt }) },
				},
				abortRequested ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: true },
			);
			// 4. Handed-off evidence only after the handoff was scheduled.
			persist(
				evidenceRecord("handed-off", {
					interruptId,
					targetName,
					senderName,
					abortRequested,
					sentAt: payload.sentAt,
					deliveredAt: Date.now(),
					content: payload.content,
				}),
			);
		} catch (error) {
			// Abort/handoff failure: pending evidence remains so reload recovery retries.
			if (error instanceof InterruptFlowError) throw error;
			return { ok: false, code: abortRequested ? "abort-failed" : "handoff-failed" };
		}

		return { ok: true, interruptId, disposition: abortRequested ? "interrupt-requested" : "direct" };
	};

	/**
	 * Reload recovery (exactly-once handoff): if the newest evidence for a
	 * target is pending-without-handed-off (crash between persist and handoff),
	 * re-deliver the recovery message before normal continuation. Returns the
	 * re-delivered record or null when nothing is pending.
	 */
	const recoverPending = async (): Promise<InterruptEvidenceRecord | null> => {
		const record = latestInterruptEvidence(surface.getEntries());
		if (!record || record.phase === "handed-off") return null;
		const payload: MessagePayload = {
			content: record.content ?? "Recovery from an interrupted turn",
			origin: { kind: "crew", name: record.senderName, role: record.senderName },
			kind: "interrupt",
			...(record.sentAt === undefined ? {} : { sentAt: record.sentAt }),
		};
		const deliveredAt = surface.now?.();
		await surface.sendMessage(
			{
				customType: "crew-interrupt",
				content:
					deliveredAt === undefined
						? `[interrupt] ${payload.content}`
						: `${formatMessageHeader({
								kind: "interrupt",
								origin: payload.origin,
								elapsedMs:
									payload.sentAt === undefined
										? undefined
										: (elapsedMessageMilliseconds(payload.sentAt, deliveredAt) ?? undefined),
							})}\n${payload.content}`,
				display: true,
				details: { messagePayload: payload, ...(deliveredAt === undefined ? {} : { deliveredAt }) },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
		persist(
			evidenceRecord("handed-off", {
				interruptId: record.interruptId,
				targetName: record.targetName,
				senderName: record.senderName,
				abortRequested: record.abortRequested,
				sentAt: record.sentAt,
				deliveredAt: Date.now(),
				content: record.content,
			}),
		);
		return record;
	};

	return { interrupt, recoverPending };
}
