import type { PresenceEffect, PresenceMember } from "../domain/index.ts";
import type { PresenceObserver } from "./presence-observer.ts";

export interface PresenceMembership {
	readonly member: PresenceMember;
	readonly notifications: boolean;
	readonly fingerprint: string;
	readonly members: readonly PresenceMember[];
}

export interface PresenceLifecycleCoordinator {
	refresh(): Promise<void>;
	stop(): Promise<void>;
	broadcast(changed: PresenceMember, state: "online" | "offline"): Promise<void>;
}

export function createPresenceLifecycleCoordinator(deps: {
	readonly getMembership: () => PresenceMembership | null;
	readonly createObserver: (membership: PresenceMembership) => PresenceObserver;
	readonly reportFailure?: (error: unknown) => void;
	readonly onObserverChanged?: (observer: PresenceObserver | undefined) => void;
	readonly onEffects?: (effects: readonly PresenceEffect[]) => void;
}): PresenceLifecycleCoordinator {
	let observer: PresenceObserver | undefined;
	let activeMember: PresenceMember | undefined;
	let activeFingerprint: string | undefined;
	const report = (error: unknown) => deps.reportFailure?.(error);
	const safeBroadcast = async (changed: PresenceMember, state: "online" | "offline") => {
		if (!observer) return;
		try {
			await observer.broadcast(changed, state);
		} catch (error) {
			report(error);
		}
	};
	const safeStop = () => {
		const current = observer;
		try {
			current?.stop();
		} catch (error) {
			report(error);
		} finally {
			observer = undefined;
			activeMember = undefined;
			activeFingerprint = undefined;
			deps.onObserverChanged?.(undefined);
		}
	};
	return {
		async refresh() {
			const membership = deps.getMembership();
			if (!membership || !membership.notifications) {
				await this.stop();
				return;
			}
			if (observer && activeMember && activeFingerprint !== membership.fingerprint) {
				await safeBroadcast(activeMember, "offline");
				safeStop();
			}
			if (observer) return;
			try {
				const next = deps.createObserver(membership);
				observer = next;
				activeMember = membership.member;
				activeFingerprint = membership.fingerprint;
				await next.start();
				deps.onObserverChanged?.(next);
			} catch (error) {
				report(error);
				safeStop();
			}
		},
		async stop() {
			if (!observer) return;
			const current = activeMember;
			await safeBroadcast(current!, "offline");
			safeStop();
		},
		broadcast: safeBroadcast,
	};
}
