import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PresenceEffect, PresenceMember } from "../domain/index.ts";
import { emitCrewPresenceActivity } from "../application/presence-activity.ts";
import { createPresenceLifecycleCoordinator, type PresenceMembership } from "../application/presence-lifecycle.ts";
import type { PresenceObserver } from "../application/presence-observer.ts";

export interface PresenceComposition {
	refresh(): Promise<void>;
	stop(): Promise<void>;
	startupSocketJoin(): Promise<void>;
	persistedRestore(): Promise<void>;
	reload(): Promise<void>;
	leave(): Promise<void>;
	stopCommand(): Promise<void>;
	sessionShutdown(): Promise<void>;
}

export function createPresenceComposition(deps: {
	readonly getMembership: () => (PresenceMembership & { readonly members: readonly PresenceMember[] }) | null;
	readonly createObserver: (
		membership: PresenceMembership,
		onEffects: (effects: readonly PresenceEffect[]) => void,
	) => PresenceObserver;
	readonly sendMessage: ExtensionAPI["sendMessage"];
	readonly reportFailure?: (error: unknown) => void;
	readonly onObserverChanged?: (observer: PresenceObserver | undefined) => void;
}): PresenceComposition {
	const emit = (effects: readonly PresenceEffect[]) => {
		const membership = deps.getMembership();
		emitCrewPresenceActivity(
			effects,
			membership
				? {
						members: membership.members,
						currentIdentity: membership.member.identity,
						notifications: membership.notifications,
					}
				: null,
			(message, options) => deps.sendMessage(message, options),
		);
	};
	const coordinator = createPresenceLifecycleCoordinator({
		getMembership: deps.getMembership,
		createObserver: (membership) => deps.createObserver(membership, emit),
		reportFailure: deps.reportFailure,
		onObserverChanged: deps.onObserverChanged,
	});
	const refresh = () => coordinator.refresh();
	const stop = () => coordinator.stop();
	return {
		refresh,
		stop,
		startupSocketJoin: refresh,
		persistedRestore: refresh,
		reload: refresh,
		leave: stop,
		stopCommand: stop,
		sessionShutdown: stop,
	};
}
