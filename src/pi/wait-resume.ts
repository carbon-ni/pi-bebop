import {
	YieldingWaitRegistry,
	validateYieldingWaitTerminal,
	type YieldingWaitKind,
	type YieldingWaitTerminal,
} from "../domain/index.ts";

export const WAIT_RESUME_MESSAGE_TYPE = "crew-wait-resume";

function recoveryGuidance(kind: YieldingWaitKind, outcome: string): string {
	if (kind !== "request-outcome") return "";
	if (outcome === "offline") return "\nRecovery: Consider reassigning or using send_to_inbox for durable delivery.";
	if (outcome === "timeout:response-after-idle")
		return "\nRecovery: The Member settled without a Response. If an answer is still required, send a new send_member_request.";
	if (outcome === "timeout:max-wait")
		return "\nRecovery: No Response arrived before the safety deadline. Consider checking Member Status, reassigning, using send_to_inbox, or using redirect_member when urgent.";
	return "";
}

export interface WaitResumeDelivery {
	readonly customType: string;
	readonly content: string;
	readonly details: unknown;
	readonly deliverAs: "steer" | "followUp";
}

export interface YieldingWaitRuntimeDependencies {
	readonly registry: YieldingWaitRegistry;
	readonly deliver: (message: WaitResumeDelivery) => void;
	readonly isRunIdle: () => boolean;
	readonly now?: () => number;
	readonly createId?: () => string;
}

export interface ParkWaitInput {
	readonly kind: YieldingWaitKind;
	readonly target: string;
	/** Own bounded deadline for the wait; omitted when the underlying request deadline bounds the outcome. */
	readonly deadlineAt?: number;
	readonly sessionId?: string;
}

/**
 * TASK-0077/0080: extension-side yield runtime. A wait tool parks a pending
 * wait and returns immediately (ending the current Pi run); the runtime later
 * resolves the oldest matching pending wait exactly once per terminal lifecycle
 * delivery and emits exactly one resume message. Busy-run arrivals are queued
 * one-shot (followUp) for the next natural turn start - never lost, never
 * doubled. Deadlines stay owned by their existing transports/timers; this
 * runtime only turns terminal lifecycle events into one-shot resume delivery
 * and tracks queued/started lifecycle state internally for cancellation and
 * exactly-once delivery.
 */
export class YieldingWaitRuntime {
	private readonly registry: YieldingWaitRegistry;
	private readonly deliver: (message: WaitResumeDelivery) => void;
	private readonly isRunIdle: () => boolean;
	private readonly now: () => number;
	private readonly createId: () => string;
	/** waitIds whose resume message is queued but has not entered context. */
	private readonly queued = new Map<string, YieldingWaitKind>();
	/** waitIds whose resume entered context and whose outcome turn has not settled. */
	private readonly started = new Map<string, YieldingWaitKind>();
	private sequence = 0;

	constructor(dependencies: YieldingWaitRuntimeDependencies) {
		this.registry = dependencies.registry;
		this.deliver = dependencies.deliver;
		this.isRunIdle = dependencies.isRunIdle;
		this.now = dependencies.now ?? Date.now;
		this.createId = dependencies.createId ?? (() => `wait-${Date.now()}-${this.sequence++}`);
	}

	park(input: ParkWaitInput): { ok: true; id: string } | { ok: false; code: string } {
		const id = this.createId();
		const registered = this.registry.register({
			id,
			kind: input.kind,
			target: input.target,
			deadlineAt: input.deadlineAt ?? 0,
			sessionId: input.sessionId ?? "",
		});
		if (registered.ok === false) return { ok: false, code: registered.code };
		// A semantic duplicate returns the EXISTING wait and creates no second
		// lifecycle state.
		if (registered.value.id !== id) return { ok: true, id: registered.value.id };
		return { ok: true, id };
	}

	/**
	 * Resolves the oldest matching parked wait and queues one resume message.
	 * Malformed/unexpected terminal payloads are rejected before any consume:
	 * the wait stays parked and nothing resumes.
	 */
	resolve(terminal: YieldingWaitTerminal): boolean {
		const validated = validateYieldingWaitTerminal(terminal);
		if (validated.ok === false) return false;
		const resolved = this.registry.resolveFirst(validated.value);
		if (resolved.ok === false) return false;
		const waitId = resolved.value.id;
		const kind = resolved.value.kind;
		const response = validated.value.response;
		// TASK-0080-fix: a correlated Response carries its FULL payload into the
		// resume content (message + ordered instructions) so the requester resumes
		// with the responder's actual answer, never a bare outcome marker.
		const responseSuffix = response
			? `\nResponse: ${response.message}\nInstructions:\n${response.instructions
					.map((item, index) => `${index + 1}. ${item}`)
					.join("\n")}`
			: "";
		const recovery = recoveryGuidance(validated.value.kind, validated.value.outcome);
		this.queued.set(waitId, kind);
		this.deliver({
			customType: WAIT_RESUME_MESSAGE_TYPE,
			content: `[wait resume] ${validated.value.kind} ${validated.value.target}: ${validated.value.outcome}${responseSuffix}${recovery}`,
			details: {
				waitId,
				kind: validated.value.kind,
				target: validated.value.target,
				outcome: validated.value.outcome,
				...(response === undefined ? {} : { response }),
				observedAt: validated.value.observedAt,
			},
			deliverAs: this.isRunIdle() ? "steer" : "followUp",
		});
		return true;
	}

	/**
	 * A run started while resumes were queued -> those resumes entered model
	 * context (the OUTCOME TURN).
	 */
	markStarted(): void {
		if (this.queued.size === 0) return;
		for (const [id, kind] of [...this.queued.entries()]) {
			this.queued.delete(id);
			this.started.set(id, kind);
		}
	}

	/**
	 * The outcome turn settled; clear its internal lifecycle state. Unrelated
	 * turns (no started ids) are a no-op.
	 */
	markSettled(): void {
		if (this.started.size === 0) return;
		for (const id of this.started.keys()) {
			this.started.delete(id);
		}
	}

	cancel(id: string): boolean {
		// TASK-0080: cancel is valid while the wait is parked (registry entry) or
		// resume-queued (runtime queue); it is IMPOSSIBLE from resume-started
		// (the request already terminated - its settle path owns that id).
		const queuedKind = this.queued.get(id);
		const startedKind = this.started.get(id);
		if (startedKind !== undefined) return false;
		const registryCancelled = this.registry.cancel(id);
		if (!registryCancelled && queuedKind === undefined) return false;
		this.queued.delete(id);
		this.started.delete(id);
		return true;
	}

	/** Shutdown cancels every parked wait. */
	cancelAll(): string[] {
		const ids = this.registry.allIds();
		for (const id of ids) this.cancel(id);
		return ids;
	}

	queuedCount(): number {
		return this.queued.size;
	}
	startedCount(): number {
		return this.started.size;
	}
}
