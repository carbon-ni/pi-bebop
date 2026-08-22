import type { PresenceMember } from "../domain/index.ts";
import {
	createPresenceObserver,
	PRESENCE_HINT_TIMEOUT_MS,
	type PresenceObserver,
	type PresenceScheduler,
} from "./presence-observer.ts";
import type { PresenceMembership } from "./presence-lifecycle.ts";

export interface PresenceWireAdapter {
	readonly scheduler: PresenceScheduler;
	readonly probe: (identity: string, timeoutMs: number) => Promise<boolean>;
	readonly resolveTarget: (identity: string) => Promise<string>;
	readonly send: (
		target: string,
		payload: { member: PresenceMember; state: "online" | "offline"; instanceId: string },
		timeoutMs: number,
	) => Promise<void>;
	readonly onEffects: (effects: readonly unknown[]) => void;
}

export function createPresenceObserverAdapter(
	membership: PresenceMembership,
	instanceId: string,
	adapter: PresenceWireAdapter,
): PresenceObserver {
	return createPresenceObserver(
		membership.members,
		membership.member.identity,
		instanceId,
		{ notifications: membership.notifications },
		{
			scheduler: adapter.scheduler,
			probe: adapter.probe,
			sendHint: async (target, changed, state) => {
				const endpoint = await adapter.resolveTarget(target.identity);
				await adapter.send(endpoint, { member: changed, state, instanceId }, PRESENCE_HINT_TIMEOUT_MS);
			},
			onEffects: (effects) => adapter.onEffects(effects),
		},
	);
}
