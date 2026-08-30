import type { MemberRequestMember, RequestOutcomeReminder } from "./member-request.ts";

export const REQUEST_REMINDER_DELAY_MS = 180_000;

export interface RequestReminderSchedulerDependencies {
	readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
	readonly clearTimeout?: (handle: unknown) => void;
	readonly now?: () => number;
	readonly onReminder?: (reminder: RequestOutcomeReminder) => void;
	/** Optional same-turn batch hook; reminders retain acceptance order. */
	readonly onReminders?: (reminders: readonly RequestOutcomeReminder[]) => void;
}

interface ReminderEntry {
	readonly requestId: string;
	readonly member: MemberRequestMember;
	readonly acceptedAt: number;
	handle?: unknown;
	reminded: boolean;
}

/** One-shot requester-side reminder clock. No recurrence and no target IO. */
export class RequestReminderScheduler {
	private readonly entries = new Map<string, ReminderEntry>();
	private readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
	private readonly clearTimeout: (handle: unknown) => void;
	private readonly now: () => number;

	constructor(private readonly dependencies: RequestReminderSchedulerDependencies) {
		this.setTimeout = dependencies.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
		this.clearTimeout =
			dependencies.clearTimeout ??
			((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
		this.now = dependencies.now ?? Date.now;
	}

	register(requestId: string, member: MemberRequestMember, acceptedAt = this.now()): void {
		this.cancel(requestId);
		const entry: ReminderEntry = { requestId, member: { ...member }, acceptedAt, reminded: false };
		entry.handle = this.setTimeout(
			() => this.fire(requestId),
			Math.max(0, acceptedAt + REQUEST_REMINDER_DELAY_MS - this.now()),
		);
		this.entries.set(requestId, entry);
	}

	cancel(requestId: string): boolean {
		const entry = this.entries.get(requestId);
		if (!entry) return false;
		if (entry.handle !== undefined) this.clearTimeout(entry.handle);
		this.entries.delete(requestId);
		return true;
	}

	cancelAll(): void {
		for (const requestId of this.entries.keys()) this.cancel(requestId);
	}

	private fire(requestId: string): void {
		const entry = this.entries.get(requestId);
		if (!entry || entry.reminded) return;
		const dueAt = entry.acceptedAt + REQUEST_REMINDER_DELAY_MS;
		const now = this.now();
		if (now < dueAt) {
			entry.handle = this.setTimeout(() => this.fire(requestId), dueAt - now);
			return;
		}
		const reminders: RequestOutcomeReminder[] = [];
		for (const candidate of this.entries.values()) {
			if (candidate.reminded || candidate.acceptedAt + REQUEST_REMINDER_DELAY_MS > now) continue;
			candidate.handle = undefined;
			candidate.reminded = true;
			reminders.push({
				kind: "still-pending",
				requestId: candidate.requestId,
				member: { ...candidate.member },
				ageSeconds: Math.max(0, Math.floor((now - candidate.acceptedAt) / 1000)),
			});
		}
		if (this.dependencies.onReminders) this.dependencies.onReminders(reminders);
		else for (const reminder of reminders) this.dependencies.onReminder?.(reminder);
	}
}
