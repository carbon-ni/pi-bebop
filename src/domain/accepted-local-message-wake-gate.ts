/**
 * TASK-0081 accepted-local-message wake seam (pure domain).
 *
 * One session-local gate that stores listeners ONLY - never message content,
 * routes, history, or Pi queue state. Bebop-owned model-bound deliveries call
 * `notifyAccepted(deliveryId)` after protocol acceptance and BEFORE
 * `pi.sendMessage`; an armed listener claims the wake and the blocked
 * `wait_for_member_idle` is released. The delivered message itself is
 * untouched: it keeps its original Follow-up/Redirect mode and FIFO position.
 *
 * Scope: Follow-up, Redirect, Member request, Inbox, Broadcast, and reminder.
 * A Response arriving on its request-scoped RPC channel is not a wake.
 * Interrupt/abort is not a wake.
 *
 * A message accepted before `arm` does not wake the later wait (public Pi API
 * does not expose accepted-versus-entered correlation and private queue
 * inspection is forbidden); the no-lost-wake guarantee begins at synchronous
 * `arm`.
 */

export interface AcceptedLocalMessageWakeListener {
	(deliveryId: string): void;
}

export type AcceptedLocalMessageWakeArmResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: "wait-in-progress" };

export class AcceptedLocalMessageWakeGate {
	private readonly listeners = new Set<AcceptedLocalMessageWakeListener>();

	/** Synchronously register the single local blocking-idle-wait listener. */
	arm(listener: AcceptedLocalMessageWakeListener): AcceptedLocalMessageWakeArmResult {
		if (this.listeners.size > 0) return { ok: false, code: "wait-in-progress" };
		this.listeners.add(listener);
		return { ok: true };
	}

	/**
	 * Claim the armed listener for an accepted Bebop model delivery. Returns
	 * true when a listener was claimed (and consumed); false when no listener
	 * is armed (pre-arm acceptance or a wait that already terminated).
	 */
	notifyAccepted(deliveryId: string): boolean {
		if (this.listeners.size === 0) return false;
		const listener = [...this.listeners][0];
		this.listeners.delete(listener);
		try {
			listener(deliveryId);
		} catch {
			/* A blocked tool may have been aborted concurrently; the claim stands. */
		}
		return true;
	}

	/** Remove a listener without claiming it (terminal cleanup / abort). */
	release(listener: AcceptedLocalMessageWakeListener): void {
		this.listeners.delete(listener);
	}

	/** True while a local blocking wait is armed (concurrency gate for tests/tools). */
	get armed(): boolean {
		return this.listeners.size > 0;
	}
}
