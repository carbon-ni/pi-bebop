import { isMessagePayload, type CrewOrigin, type MessagePayload } from "./message-payload.ts";
import type { CrewManifest, CrewMember } from "./crew-manifest.ts";

/**
 * Member Interrupt domain contract (TASK-0044, define-only).
 *
 * Interrupt is the internal hard-recovery operation stronger than Redirect:
 *
 *   Follow-up  -> waits until the agent finishes
 *   Redirect   -> Pi steer: the current assistant turn/tool calls finish, then
 *                 guidance enters before the next model call
 *   Interrupt  -> abort the active operation, then recovery guidance enters
 *                 before previously queued follow-ups
 *
 * It is destructive control, not an urgency label: it may cancel abort-aware
 * model/tool work but cannot undo completed or non-cooperative side effects.
 * External actors, Inbox, Crew Intake, and Broadcast cannot invoke it; only a
 * current joined member can interrupt another configured member.
 *
 * Characterization (Pi 0.84.2) — recovery precedence after abort is PROVEN:
 *
 *   1. `ctx.abort()` aborts the active stream; the run emits `agent_end`
 *      (stopReason "aborted") and awaits all listeners before settling.
 *   2. An extension `agent_end` handler queues the recovery guidance via
 *      `steer()` (never `followUp()`).
 *   3. `AgentSession._handlePostAgentRun()` sees `hasQueuedMessages()` and
 *      calls `agent.continue()`; the agent loop drains the steering queue
 *      BEFORE the follow-up queue (inner loop checks steering at the top of
 *      every iteration; follow-ups only drain after the agent would stop).
 *
 * Therefore recovery guidance becomes the next model-visible message ahead of
 * any older queued follow-ups. Queues are never cleared by abort (only by
 * session reset). This contract encodes the ordering rule and the evidence
 * shape; the tool and runtime adapters are TASK-0045.
 *
 * Transport is not part of this file: a live target's busy/idle state and the
 * actual abort RPC are application concerns. Here we define the pure
 * resolution, id, payload, disposition, and evidence contracts.
 */

export type MemberInterruptErrorCode =
	| "invalid-request"
	| "unknown-member"
	| "ambiguous-member"
	| "self-interrupt"
	| "not-a-member"
	| "invalid-payload";

export class MemberInterruptError extends Error {
	readonly code: MemberInterruptErrorCode;

	constructor(code: MemberInterruptErrorCode, message: string) {
		super(message);
		this.name = "MemberInterruptError";
		this.code = code;
	}
}

export interface MemberInterruptRequest {
	readonly senderName: string;
	readonly targetName: string;
	readonly message: string;
	readonly instructions?: readonly string[];
	readonly requestedAt: number;
}

export type InterruptTargetResolution =
	| { readonly ok: true; readonly target: CrewMember }
	| { readonly ok: false; readonly code: "self-interrupt" | "not-a-member" | "unknown-member" | "ambiguous-member" };

/** Resolves the interrupt target exactly like member messaging: exact name, or unique role. */
export function resolveInterruptTarget(
	manifest: CrewManifest,
	senderName: string,
	targetName: string,
): InterruptTargetResolution {
	if (typeof targetName !== "string" || targetName.trim().length === 0 || targetName.includes("\0"))
		return { ok: false, code: "unknown-member" };
	const byName = manifest.members.find((member) => member.name === targetName);
	const byRole = manifest.members.filter((member) => member.role === targetName);
	const target = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!target) {
		if (byRole.length > 1) return { ok: false, code: "ambiguous-member" };
		return { ok: false, code: "unknown-member" };
	}
	if (target.name === senderName) return { ok: false, code: "self-interrupt" };
	if (!manifest.members.some((member) => member.name === senderName)) return { ok: false, code: "not-a-member" };
	return { ok: true, target };
}

function invalidRequest(message: string): never {
	throw new MemberInterruptError("invalid-request", message);
}

function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (const byte of Buffer.from(text, "utf8")) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16);
}

/** Stable interrupt id: deterministic per (sender, target, message, ordered instructions). */
export function createInterruptId(request: MemberInterruptRequest): string {
	if (
		typeof request.senderName !== "string" ||
		request.senderName.trim().length === 0 ||
		request.senderName.includes("\0")
	)
		invalidRequest("interrupt sender must be a non-empty canonical member name");
	if (
		typeof request.targetName !== "string" ||
		request.targetName.trim().length === 0 ||
		request.targetName.includes("\0")
	)
		invalidRequest("interrupt target must be a non-empty member name or unique role");
	if (typeof request.message !== "string" || request.message.trim().length === 0)
		invalidRequest("interrupt message must be non-empty");
	const instructions = request.instructions ?? [];
	if (instructions.some((item) => typeof item !== "string" || item.trim().length === 0))
		invalidRequest("interrupt instructions must be non-empty strings");
	const digest = fnv1a(
		JSON.stringify({
			senderName: request.senderName,
			targetName: request.targetName,
			message: request.message,
			instructions: [...instructions],
		}),
	);
	return `interrupt-${digest}`;
}

/** Derived crew origin from the manifest member — never caller-claimed input. */
export function deriveInterruptOrigin(sender: CrewMember): CrewOrigin {
	return { kind: "crew", name: sender.name, role: sender.role };
}

/** Recovery payload: content + ordered instructions + derived crew origin; never adds a reply route. */
export function createInterruptRecoveryPayload(sender: CrewMember, request: MemberInterruptRequest): MessagePayload {
	const payload: MessagePayload = {
		content: request.message,
		origin: deriveInterruptOrigin(sender),
		kind: "interrupt",
		sentAt: request.requestedAt,
		...(request.instructions === undefined ? {} : { instructions: [...request.instructions] }),
	};
	if (!isMessagePayload(payload))
		throw new MemberInterruptError("invalid-payload", "invalid interrupt recovery message");
	return payload;
}

/**
 * Disposition contract. `interrupt-requested` means an abort was actually
 * requested against a busy target; `direct` means the target was idle and
 * recovery started immediately without an abort. These are distinct
 * acknowledgements — an idle target must never report an abort that did not
 * occur, and a busy target must never be reported as a clean direct send.
 */
export type InterruptDisposition =
	| { readonly kind: "interrupt-requested"; readonly interruptId: string; readonly targetName: string }
	| { readonly kind: "direct"; readonly interruptId: string; readonly targetName: string };

export function isInterruptDisposition(value: unknown): value is InterruptDisposition {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.kind !== "interrupt-requested" && candidate.kind !== "direct") return false;
	return (
		typeof candidate.interruptId === "string" &&
		candidate.interruptId.length > 0 &&
		typeof candidate.targetName === "string" &&
		candidate.targetName.length > 0
	);
}

export interface InterruptEvidenceInput {
	readonly interruptId: string;
	readonly senderName: string;
	readonly targetName: string;
	readonly message: string;
	readonly abortRequested: boolean;
	readonly deliveredAt: number;
}

/**
 * Audit record of who interrupted whom and why. Transport-only: it proves the
 * request, the abort intent, and the recovery handoff — it never claims
 * completed or undone side effects, and it never exposes a reply route.
 */
export interface InterruptEvidence {
	readonly interruptId: string;
	readonly senderName: string;
	readonly targetName: string;
	readonly message: string;
	readonly abortRequested: boolean;
	readonly deliveredAt: number;
}

export function createInterruptEvidence(input: InterruptEvidenceInput): InterruptEvidence {
	if (
		typeof input.interruptId !== "string" ||
		input.interruptId.length === 0 ||
		typeof input.senderName !== "string" ||
		input.senderName.length === 0 ||
		typeof input.targetName !== "string" ||
		input.targetName.length === 0 ||
		typeof input.message !== "string" ||
		input.message.length === 0 ||
		typeof input.abortRequested !== "boolean" ||
		typeof input.deliveredAt !== "number" ||
		!Number.isFinite(input.deliveredAt)
	)
		throw new MemberInterruptError(
			"invalid-request",
			"interrupt evidence requires valid identity, message, and time",
		);
	return {
		interruptId: input.interruptId,
		senderName: input.senderName,
		targetName: input.targetName,
		message: input.message,
		abortRequested: input.abortRequested,
		deliveredAt: input.deliveredAt,
	};
}

/**
 * One-pending-interrupt-per-target gate (pure, definition-only). A later
 * concurrent request for the same target is rejected rather than replacing the
 * first recovery guidance. The app layer (TASK-0045) owns the durable
 * pending-set; this is the decision rule.
 */
export function rejectIfPending(
	pendingTargets: ReadonlySet<string>,
	targetName: string,
): { readonly ok: true } | { readonly ok: false; readonly code: "already-pending" } {
	return pendingTargets.has(targetName) ? { ok: false, code: "already-pending" } : { ok: true };
}
