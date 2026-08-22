import {
	createInitialPresenceState,
	reducePresence,
	type PresenceEffect,
	type PresenceMember,
	type PresenceState,
} from "../domain/index.ts";

export const PRESENCE_RECONCILE_INTERVAL_MS = 5_000;
export const PRESENCE_PROBE_TIMEOUT_MS = 500;

export interface PresenceScheduler {
	schedule(delayMs: number, callback: () => void): unknown;
	cancel(handle: unknown): void;
}
export interface PresenceObserverDependencies {
	scheduler: PresenceScheduler;
	probe(identity: string, timeoutMs: number): Promise<boolean>;
	sendHint(target: PresenceMember, changed: PresenceMember, state: "online" | "offline"): Promise<void>;
	onEffects(effects: readonly PresenceEffect[]): void;
}
export interface PresenceObserver {
	start(): Promise<void>;
	reconcile(): Promise<void>;
	broadcast(changed: PresenceMember, state: "online" | "offline"): Promise<void>;
	acceptHint(hint: { member: PresenceMember; state: "online" | "offline"; instanceId: string }): boolean;
	stop(): void;
	getState(): PresenceState;
}

export function createPresenceObserver(
	members: readonly PresenceMember[],
	currentIdentity: string,
	instanceId: string,
	config: { notifications: boolean },
	dependencies: PresenceObserverDependencies,
): PresenceObserver {
	let generation = 0;
	let active = false;
	let timer: unknown;
	let starting: Promise<void> | undefined;
	let state = createInitialPresenceState(members, currentIdentity, config);
	const peers = () => members.filter((member) => member.identity !== currentIdentity);
	const isActive = (token: number) => active && token === generation;
	const broadcast = async (changed: PresenceMember, status: "online" | "offline") => {
		if (!config.notifications) return;
		await Promise.allSettled(peers().map((target) => dependencies.sendHint(target, changed, status)));
	};
	const scan = async (token: number) => {
		const results = await Promise.all(
			peers().map(async (member) => {
				try {
					return { member, online: await dependencies.probe(member.identity, PRESENCE_PROBE_TIMEOUT_MS) };
				} catch {
					return { member, online: false };
				}
			}),
		);
		if (!isActive(token)) return;
		for (const result of results) {
			const reduced = reducePresence(state, {
				members,
				currentMemberIdentity: currentIdentity,
				event: { type: "observation", memberIdentity: result.member.identity, online: result.online },
			});
			state = reduced.state;
			if (reduced.effects.length > 0) dependencies.onEffects(reduced.effects);
		}
		if (!state.initialScanComplete) {
			const reduced = reducePresence(state, {
				members,
				currentMemberIdentity: currentIdentity,
				event: { type: "initial-scan-complete" },
			});
			state = reduced.state;
			if (reduced.effects.length > 0) dependencies.onEffects(reduced.effects);
		}
	};
	const schedule = (token: number) => {
		if (isActive(token))
			timer = dependencies.scheduler.schedule(PRESENCE_RECONCILE_INTERVAL_MS, () => void reconcile());
	};
	const reconcile = async () => {
		if (!active) return;
		const token = generation;
		await scan(token);
		schedule(token);
	};
	return {
		async start() {
			if (!config.notifications || active) return;
			active = true;
			generation += 1;
			const token = generation;
			starting = reconcile()
				.then(async () => {
					if (isActive(token))
						await broadcast(members.find((member) => member.identity === currentIdentity)!, "online");
				})
				.finally(() => {
					starting = undefined;
				});
			await starting;
		},
		reconcile,
		broadcast,
		acceptHint(hint) {
			if (!active || !config.notifications || !hint.instanceId || hint.instanceId === instanceId) return false;
			const member = members.find(
				(candidate) =>
					candidate.identity === hint.member.identity &&
					candidate.name === hint.member.name &&
					candidate.role === hint.member.role,
			);
			if (!member) return false;
			const token = generation;
			void dependencies
				.probe(member.identity, PRESENCE_PROBE_TIMEOUT_MS)
				.then((online) => {
					if (!isActive(token)) return;
					const reduced = reducePresence(state, {
						members,
						currentMemberIdentity: currentIdentity,
						event: { type: "observation", memberIdentity: member.identity, online },
					});
					state = reduced.state;
					if (reduced.effects.length > 0) dependencies.onEffects(reduced.effects);
				})
				.catch(() => undefined);
			return true;
		},
		stop() {
			if (!active) return;
			active = false;
			generation += 1;
			if (timer !== undefined) dependencies.scheduler.cancel(timer);
			timer = undefined;
		},
		getState: () => state,
	};
}
