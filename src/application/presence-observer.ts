import {
	createInitialPresenceState,
	reducePresence,
	type PresenceEffect,
	type PresenceMember,
	type PresenceState,
} from "../domain/index.ts";

export const PRESENCE_RECONCILE_INTERVAL_MS = 5_000;
export const PRESENCE_PROBE_TIMEOUT_MS = 500;
export const PRESENCE_OFFLINE_FAILURE_THRESHOLD = 2;

export interface PresenceScheduler {
	schedule(delayMs: number, callback: () => void): unknown;
	cancel(handle: unknown): void;
}
export interface PresenceObserverDependencies {
	scheduler: PresenceScheduler;
	probe(identity: string, timeoutMs: number): Promise<boolean>;
	sendHint(member: PresenceMember, state: "online" | "offline"): Promise<void>;
	onEffects(effects: readonly PresenceEffect[]): void;
}
export interface PresenceObserver {
	start(): Promise<void>;
	reconcile(): Promise<void>;
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
	let timer: unknown;
	let state = createInitialPresenceState(members, currentIdentity, config);
	const activeMembers = () => members.filter((member) => member.identity !== currentIdentity);
	const isCurrentGeneration = (value: number) => value === generation;
	const applyScan = async (scanGeneration: number): Promise<void> => {
		const targets = activeMembers();
		const results = await Promise.all(
			targets.map(async (member) => {
				try {
					return { member, online: await dependencies.probe(member.identity, PRESENCE_PROBE_TIMEOUT_MS) };
				} catch {
					return { member, online: false };
				}
			}),
		);
		if (!isCurrentGeneration(scanGeneration)) return;
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
	const scheduleNext = () => {
		if (config.notifications && isCurrentGeneration(generation))
			timer = dependencies.scheduler.schedule(PRESENCE_RECONCILE_INTERVAL_MS, () => void reconcile());
	};
	const reconcile = async () => {
		const scanGeneration = generation;
		await applyScan(scanGeneration);
		if (isCurrentGeneration(scanGeneration)) scheduleNext();
	};
	return {
		async start() {
			if (!config.notifications) return;
			generation += 1;
			await reconcile();
			if (isCurrentGeneration(generation)) {
				for (const member of activeMembers())
					void dependencies.sendHint(member, "online").catch(() => undefined);
			}
		},
		reconcile,
		acceptHint(hint) {
			if (!config.notifications || hint.instanceId === instanceId || !hint.instanceId) return false;
			const member = members.find(
				(candidate) =>
					candidate.identity === hint.member.identity &&
					candidate.name === hint.member.name &&
					candidate.role === hint.member.role,
			);
			if (!member) return false;
			const hintGeneration = generation;
			void dependencies
				.probe(member.identity, PRESENCE_PROBE_TIMEOUT_MS)
				.then((online) => {
					if (isCurrentGeneration(hintGeneration)) {
						const reduced = reducePresence(state, {
							members,
							currentMemberIdentity: currentIdentity,
							event: { type: "observation", memberIdentity: member.identity, online },
						});
						state = reduced.state;
						if (reduced.effects.length > 0) dependencies.onEffects(reduced.effects);
					}
				})
				.catch(() => undefined);
			return true;
		},
		stop() {
			generation += 1;
			if (timer !== undefined) dependencies.scheduler.cancel(timer);
			timer = undefined;
		},
		getState: () => state,
	};
}
