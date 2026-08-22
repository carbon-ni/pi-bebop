import type { PresenceMember } from "../domain/index.ts";
import type { PresenceObserver } from "./presence-observer.ts";

export interface PresenceMembership {
	readonly member: PresenceMember;
	readonly notifications: boolean;
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
}): PresenceLifecycleCoordinator {
	let observer: PresenceObserver | undefined;
	let activeMember: PresenceMember | undefined;
	const report = (error: unknown) => deps.reportFailure?.(error);
	const safeBroadcast = async (changed: PresenceMember, state: "online" | "offline") => {
		if (!observer) return;
		try {
			await observer.broadcast(changed, state);
		} catch (error) {
			report(error);
		}
	};
	return {
		async refresh() {
			const membership = deps.getMembership();
			if (!membership || !membership.notifications) {
				await this.stop();
				return;
			}
			if (observer && activeMember && activeMember.identity !== membership.member.identity) {
				await safeBroadcast(activeMember, "offline");
				observer.stop();
				observer = undefined;
				activeMember = undefined;
			}
			if (observer) return;
			try {
				const next = deps.createObserver(membership);
				observer = next;
				activeMember = membership.member;
				await next.start();
			} catch (error) {
				report(error);
				observer?.stop();
				observer = undefined;
				activeMember = undefined;
			}
		},
		async stop() {
			if (!observer) return;
			const current = activeMember;
			await safeBroadcast(current!, "offline");
			observer.stop();
			observer = undefined;
			activeMember = undefined;
		},
		broadcast: safeBroadcast,
	};
}
