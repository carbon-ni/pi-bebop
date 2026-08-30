export const MAX_YIELDING_WAITS = 16;

export type YieldingWaitKind = "member-idle" | "request-outcome";

export interface PendingYieldingWait {
	readonly id: string;
	readonly kind: YieldingWaitKind;
	readonly target: string;
	readonly deadlineAt: number;
	readonly sessionId: string;
}

export interface YieldingWaitTerminal {
	readonly kind: YieldingWaitKind;
	readonly target: string;
	readonly outcome: string;
	readonly observedAt: number;
	/**
	 * Correlated Response payload. Present ONLY for a request-outcome terminal
	 * with outcome "response"; other kinds/outcomes must omit it. Preserves the
	 * responder's message + ordered instructions through the crew-wait-resume
	 * (the requester resumes with the FULL terminal outcome, never a bare marker).
	 */
	readonly response?: { readonly message: string; readonly instructions: readonly string[] };
	/** Nonterminal requester reminder metadata; exclusive to still-pending. */
	readonly reminder?: {
		readonly member: { readonly name: string; readonly role: string };
		readonly ageSeconds: number;
	};
	/** Number of outbound Requests remaining after this event. */
	readonly pending_count?: number;
}

const MEMBER_IDLE_OUTCOMES = new Set(["became-idle", "already-idle", "offline", "timeout"]);
// TASK-0080: idle-without-response is removed from the public union; timeout
// carries an explicit reason marker in the terminal outcome.
const REQUEST_OUTCOME_OUTCOMES = new Set([
	"response",
	"offline",
	"timeout:max-wait",
	"timeout:response-after-idle",
	"still-pending",
]);

export type TerminalValidationResult =
	| { readonly ok: true; readonly value: YieldingWaitTerminal }
	| {
			readonly ok: false;
			readonly code:
				| "invalid-kind"
				| "invalid-target"
				| "invalid-outcome"
				| "invalid-observed-at"
				| "invalid-response";
	  };

/** TASK-0080-fix: response payload bounds mirror MessagePayload instructions. */
const MAX_RESPONSE_INSTRUCTIONS = 32;
const validResponseInstructions = (instructions: unknown): boolean =>
	Array.isArray(instructions) &&
	instructions.length <= MAX_RESPONSE_INSTRUCTIONS &&
	instructions.every((item) => typeof item === "string" && item.trim().length > 0);

/**
 * TASK-0077: terminal payload gate. Only well-formed terminal outcomes for the
 * wait kind may consume a parked wait and emit a resume; malformed or
 * unexpected deliveries (unknown outcome markers, non-finite timestamps, empty
 * targets, unknown kinds) are rejected before any consume and leave the wait
 * parked, never resuming.
 */
export function validateYieldingWaitTerminal(input: unknown): TerminalValidationResult {
	if (typeof input !== "object" || input === null) return { ok: false, code: "invalid-kind" };
	const kind = (input as { kind?: unknown }).kind;
	if (kind !== "member-idle" && kind !== "request-outcome") return { ok: false, code: "invalid-kind" };
	const target = (input as { target?: unknown }).target;
	if (typeof target !== "string" || target.length === 0) return { ok: false, code: "invalid-target" };
	const outcome = (input as { outcome?: unknown }).outcome;
	if (typeof outcome !== "string" || outcome.length === 0) return { ok: false, code: "invalid-outcome" };
	const allowed = kind === "member-idle" ? MEMBER_IDLE_OUTCOMES : REQUEST_OUTCOME_OUTCOMES;
	if (!allowed.has(outcome)) return { ok: false, code: "invalid-outcome" };
	const observedAt = (input as { observedAt?: unknown }).observedAt;
	if (typeof observedAt !== "number" || !Number.isFinite(observedAt))
		return { ok: false, code: "invalid-observed-at" };
	const response = (input as { response?: unknown }).response;
	const reminder = (input as { reminder?: unknown }).reminder;
	const pendingCount = (input as { pending_count?: unknown }).pending_count;
	if (
		pendingCount !== undefined &&
		(typeof pendingCount !== "number" || !Number.isInteger(pendingCount) || pendingCount < 0)
	)
		return { ok: false, code: "invalid-response" };
	if (kind === "request-outcome" && outcome === "still-pending") {
		if (typeof reminder !== "object" || reminder === null) return { ok: false, code: "invalid-response" };
		const member = (reminder as { member?: unknown }).member;
		const ageSeconds = (reminder as { ageSeconds?: unknown }).ageSeconds;
		if (
			typeof member !== "object" ||
			member === null ||
			typeof (member as { name?: unknown }).name !== "string" ||
			typeof (member as { role?: unknown }).role !== "string" ||
			typeof ageSeconds !== "number" ||
			!Number.isFinite(ageSeconds) ||
			ageSeconds < 0
		)
			return { ok: false, code: "invalid-response" };
		if (response !== undefined) return { ok: false, code: "invalid-response" };
	} else if (reminder !== undefined) {
		return { ok: false, code: "invalid-response" };
	}
	if (kind === "request-outcome" && outcome === "response") {
		if (typeof response !== "object" || response === null) return { ok: false, code: "invalid-response" };
		const message = (response as { message?: unknown }).message;
		if (typeof message !== "string" || message.trim().length === 0) return { ok: false, code: "invalid-response" };
		const instructions = (response as { instructions?: unknown }).instructions;
		if (instructions !== undefined && !validResponseInstructions(instructions))
			return { ok: false, code: "invalid-response" };
	} else if (response !== undefined) {
		// The correlated Response payload is exclusive to the "response" outcome.
		return { ok: false, code: "invalid-response" };
	}
	return { ok: true, value: input as YieldingWaitTerminal };
}

export type YieldingWaitOperation<T> =
	| { ok: true; value: T }
	| { ok: false; code: "invalid-wait" | "duplicate-wait" | "capacity" | "no-pending-wait" };

/**
 * TASK-0077: pure one-shot pending-wait registry for yielding coordination
 * waits. A wait tool parks a pending wait here and returns immediately
 * (yielding the current Pi run); the runtime later resolves the oldest
 * matching pending wait exactly once per terminal lifecycle delivery and emits
 * one resume message. Callers own sockets, timers, Pi message delivery, and
 * cancellation on abort.
 */
export class YieldingWaitRegistry {
	private readonly pending: PendingYieldingWait[] = [];
	private readonly byId = new Map<string, PendingYieldingWait>();

	register(input: PendingYieldingWait): YieldingWaitOperation<PendingYieldingWait> {
		if (input.id.trim() !== input.id || input.id.length === 0) return { ok: false, code: "invalid-wait" };
		// TASK-0080: a semantic duplicate (same session + kind + target/request)
		// is idempotent: it returns the EXISTING wait id and existing parked
		// state, opening no second entry (and, upstream, no socket/timer and no
		// shared event). Cancel-then-re-park creates a NEW wait id because the
		// entry is gone by then.
		const existing = this.pending.find(
			(entry) =>
				entry.sessionId === input.sessionId && entry.kind === input.kind && entry.target === input.target,
		);
		if (existing) return { ok: true, value: existing };
		if (this.byId.has(input.id)) return { ok: false, code: "duplicate-wait" };
		if (this.pending.length >= MAX_YIELDING_WAITS) return { ok: false, code: "capacity" };
		const entry: PendingYieldingWait = { ...input };
		this.pending.push(entry);
		this.byId.set(entry.id, entry);
		return { ok: true, value: entry };
	}

	/**
	 * Resolves the oldest pending wait for this kind exactly once. Member-idle
	 * waits are target-scoped (the terminal event names the member);
	 * request-outcome waits are FIFO (the wait is for the oldest terminal
	 * outbound Request outcome, whichever request it belongs to).
	 */
	resolveFirst(terminal: YieldingWaitTerminal): YieldingWaitOperation<PendingYieldingWait> {
		const index = this.pending.findIndex(
			(entry) =>
				entry.kind === terminal.kind && (entry.kind !== "member-idle" || entry.target === terminal.target),
		);
		if (index === -1) return { ok: false, code: "no-pending-wait" };
		const [entry] = this.pending.splice(index, 1);
		this.byId.delete(entry.id);
		return { ok: true, value: entry };
	}

	/** Removes a pending wait without emitting; false when unknown or already resolved. */
	cancel(id: string): boolean {
		const entry = this.byId.get(id);
		if (!entry) return false;
		this.byId.delete(id);
		const index = this.pending.indexOf(entry);
		if (index !== -1) this.pending.splice(index, 1);
		return true;
	}

	pendingCount(): number {
		return this.pending.length;
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	/** Read-only peek of a parked wait (event kind attribution, TASK-0080). */
	peek(id: string): PendingYieldingWait | undefined {
		const entry = this.byId.get(id);
		return entry ? { ...entry } : undefined;
	}

	/** All parked wait ids (shutdown cancel-all, TASK-0080). */
	allIds(): string[] {
		return [...this.byId.keys()];
	}
}
