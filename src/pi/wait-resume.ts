import {
	YieldingWaitRegistry,
	validateYieldingWaitTerminal,
	type YieldingWaitKind,
	type YieldingWaitTerminal,
	type RequestOutcomeReminder,
} from "../domain/index.ts";

export const WAIT_RESUME_MESSAGE_TYPE = "crew-wait-resume";

/** TASK-0080: pinned shared event names (Bebop publishes, fire-and-forget). */
export const WAIT_PARKED = "pi-bebop:wait-parked";
export const WAIT_RESUME_QUEUED = "pi-bebop:wait-resume-queued";
export const WAIT_RESUME_STARTED = "pi-bebop:wait-resume-started";
export const WAIT_RESUME_SETTLED = "pi-bebop:wait-resume-settled";
export const WAIT_CANCELLED = "pi-bebop:wait-cancelled";

export interface WaitEvent {
	readonly type: string;
	readonly waitId: string;
	readonly kind: YieldingWaitKind;
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
	/** TASK-0080: fire-and-forget shared event publisher (pi.appendEntry). */
	readonly publish?: (event: WaitEvent) => void;
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
 * wait and returns immediately (yielding the current Pi run); the runtime later
 * resolves the oldest matching pending wait exactly once per terminal lifecycle
 * delivery and emits exactly one resume message. Busy-run arrivals are queued
 * one-shot (followUp) for the next natural turn start - never lost, never
 * doubled. Deadlines stay owned by their existing transports/timers; this
 * runtime only turns terminal lifecycle events into one-shot resume delivery
 * and publishes the TASK-0080 five-event machine
 * (parked -> resume-queued -> resume-started -> resume-settled | cancelled).
 */
export class YieldingWaitRuntime {
	private readonly registry: YieldingWaitRegistry;
	private readonly deliver: (message: WaitResumeDelivery) => void;
	private readonly isRunIdle: () => boolean;
	private readonly publish: (event: WaitEvent) => void;
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
		this.publish = dependencies.publish ?? (() => undefined);
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
		// TASK-0080: a semantic duplicate returns the EXISTING wait and publishes
		// no new shared event; only a first park emits wait-parked.
		if (registered.value.id !== id) return { ok: true, id: registered.value.id };
		this.publish({ type: WAIT_PARKED, waitId: id, kind: input.kind });
		return { ok: true, id };
	}

	/**
	 * Resolves the oldest matching parked wait and queues one resume message.
	 * Publishes wait-resume-queued and arms the queued -> started -> settled
	 * correlation (details.waitId). Malformed/unexpected terminal payloads are
	 * rejected before any consume: the wait stays parked and nothing resumes.
	 */
	resolve(terminal: YieldingWaitTerminal): boolean {
		const validated = validateYieldingWaitTerminal(terminal);
		if (validated.ok === false) return false;
		const resolved = this.registry.resolveFirst(validated.value);
		if (resolved.ok === false) return false;
		const waitId = resolved.value.id;
		const kind = resolved.value.kind;
		const response = validated.value.response;
		const reminder = validated.value.reminder;
		const pendingCount = validated.value.pending_count;
		// TASK-0080-fix: a correlated Response carries its FULL payload into the
		// resume content (message + ordered instructions) so the requester resumes
		// with the responder's actual answer, never a bare outcome marker.
		const responseSuffix = response
			? `\nResponse: ${response.message}\nInstructions:\n${response.instructions
					.map((item, index) => `${index + 1}. ${item}`)
					.join("\n")}`
			: reminder
				? `\nReminder: ${reminder.member.name} (${reminder.member.role}) is still pending after ${reminder.ageSeconds}s.`
				: "";
		this.queued.set(waitId, kind);
		this.publish({ type: WAIT_RESUME_QUEUED, waitId, kind });
		this.deliver({
			customType: WAIT_RESUME_MESSAGE_TYPE,
			content: `[wait resume] ${validated.value.kind} ${validated.value.target}: ${validated.value.outcome}${responseSuffix}`,
			details: {
				waitId,
				kind: validated.value.kind,
				target: validated.value.target,
				outcome: validated.value.outcome,
				...(response === undefined ? {} : { response }),
				...(reminder === undefined ? {} : { reminder }),
				...(pendingCount === undefined ? {} : { pending_count: pendingCount }),
				observedAt: validated.value.observedAt,
			},
			deliverAs: this.isRunIdle() ? "steer" : "followUp",
		});
		return true;
	}

	/**
	 * TASK-0080: a run started while resumes were queued -> those resumes entered
	 * model context (the OUTCOME TURN). Emits wait-resume-started once per id.
	 */
	markStarted(): void {
		if (this.queued.size === 0) return;
		for (const [id, kind] of [...this.queued.entries()]) {
			this.queued.delete(id);
			this.started.set(id, kind);
			this.publish({ type: WAIT_RESUME_STARTED, waitId: id, kind });
		}
	}

	/**
	 * TASK-0080: the outcome turn settled -> emit wait-resume-settled once per
	 * started id; unrelated turns (no started ids) publish nothing.
	 */
	markSettled(): void {
		if (this.started.size === 0) return;
		for (const [id, kind] of [...this.started.entries()]) {
			this.started.delete(id);
			this.publish({ type: WAIT_RESUME_SETTLED, waitId: id, kind });
		}
	}

	cancel(id: string): boolean {
		// TASK-0080: cancel is valid while the wait is parked (registry entry) or
		// resume-queued (runtime queue); it is IMPOSSIBLE from resume-started
		// (the request already terminated - its settle path owns that id).
		const entry = this.registry.peek(id);
		const queuedKind = this.queued.get(id);
		const startedKind = this.started.get(id);
		if (startedKind !== undefined) return false;
		const registryCancelled = this.registry.cancel(id);
		if (!registryCancelled && queuedKind === undefined) return false;
		const kind = entry?.kind ?? queuedKind ?? "request-outcome";
		this.queued.delete(id);
		this.started.delete(id);
		this.publish({ type: WAIT_CANCELLED, waitId: id, kind });
		return true;
	}

	/** TASK-0080: shutdown cancels every parked wait (wait-cancelled per id). */
	cancelAll(): string[] {
		const ids = this.registry.allIds();
		for (const id of ids) this.cancel(id);
		return ids;
	}

	/** Queue requester-only reminders when no wait is parked, preserving FIFO. */
	deliverReminders(reminders: readonly RequestOutcomeReminder[]): void {
		if (reminders.length === 0) return;
		const summary = reminders
			.map(
				(reminder) =>
					`Request ${reminder.requestId} for ${reminder.member.name} (${reminder.member.role}) is still pending after ${reminder.ageSeconds}s`,
			)
			.join("\n");
		this.deliver({
			customType: WAIT_RESUME_MESSAGE_TYPE,
			content: `[request reminder]\n${summary}\nConsider an ordinary Follow-up if useful; no reminder is sent to the target.`,
			details: {
				requestReminders: reminders.map((reminder) => ({ ...reminder, member: { ...reminder.member } })),
			},
			deliverAs: this.isRunIdle() ? "steer" : "followUp",
		});
	}

	deliverReminder(reminder: RequestOutcomeReminder): void {
		this.deliverReminders([reminder]);
	}

	queuedCount(): number {
		return this.queued.size;
	}
	startedCount(): number {
		return this.started.size;
	}
}
