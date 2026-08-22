import {
	createInitialPresenceState,
	reducePresence,
	type PresenceEffect,
	type PresenceMember,
	type PresenceState,
} from "../domain/index.ts";

export const PRESENCE_RECONCILE_INTERVAL_MS = 5_000;
export const PRESENCE_PROBE_TIMEOUT_MS = 500;
export const PRESENCE_HINT_TIMEOUT_MS = 500;

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
	let scanPromise: Promise<void> | undefined;
	const revisions = new Map<string, number>();
	const pendingHints = new Map<string, { token: number; member: PresenceMember }>();
	let state = createInitialPresenceState(members, currentIdentity, config);
	const peers = () => members.filter((member) => member.identity !== currentIdentity);
	const isActive = (token: number) => active && token === generation;
	const broadcast = async (changed: PresenceMember, status: "online" | "offline") => {
		if (!active || !config.notifications) return;
		await Promise.allSettled(peers().map((target) => dependencies.sendHint(target, changed, status)));
	};
	const applyObservation = (member: PresenceMember, online: boolean, revision: number) => {
		if (revisions.get(member.identity) !== revision) return;
		const reduced = reducePresence(state, {
			members,
			currentMemberIdentity: currentIdentity,
			event: { type: "observation", memberIdentity: member.identity, online },
		});
		state = reduced.state;
		if (reduced.effects.length > 0) dependencies.onEffects(reduced.effects);
	};
	const scan = async (token: number) => {
		const results = await Promise.all(
			peers().map(async (member) => {
				const revision = (revisions.get(member.identity) ?? 0) + 1;
				revisions.set(member.identity, revision);
				try {
					return {
						member,
						revision,
						online: await dependencies.probe(member.identity, PRESENCE_PROBE_TIMEOUT_MS),
					};
				} catch {
					return { member, revision, online: false };
				}
			}),
		);
		if (!isActive(token)) return;
		for (const result of results) applyObservation(result.member, result.online, result.revision);
		if (!state.initialScanComplete) {
			const reduced = reducePresence(state, {
				members,
				currentMemberIdentity: currentIdentity,
				event: { type: "initial-scan-complete" },
			});
			state = reduced.state;
			if (reduced.effects.length > 0) dependencies.onEffects(reduced.effects);
			for (const { member, token: hintToken } of pendingHints.values()) void probeHint(member, hintToken);
			pendingHints.clear();
		}
	};
	const schedule = (token: number) => {
		if (!isActive(token) || timer !== undefined) return;
		let handle!: unknown;
		handle = dependencies.scheduler.schedule(PRESENCE_RECONCILE_INTERVAL_MS, () => {
			if (timer !== handle || generation !== token || !active) return;
			timer = undefined;
			void reconcile(token);
		});
		timer = handle;
	};
	const probeHint = (member: PresenceMember, token: number) => {
		const revision = (revisions.get(member.identity) ?? 0) + 1;
		revisions.set(member.identity, revision);
		void dependencies
			.probe(member.identity, PRESENCE_PROBE_TIMEOUT_MS)
			.then((online) => {
				if (isActive(token)) applyObservation(member, online, revision);
			})
			.catch(() => undefined);
	};
	const reconcile = async (requestedToken?: number) => {
		if (!active || (requestedToken !== undefined && requestedToken !== generation)) return;
		if (scanPromise) return scanPromise;
		const token = requestedToken ?? generation;
		const run = scan(token);
		let wrapped!: Promise<void>;
		wrapped = run.finally(() => {
			if (scanPromise !== wrapped) return;
			scanPromise = undefined;
			if (isActive(token)) schedule(token);
		});
		scanPromise = wrapped;
		await wrapped;
	};
	return {
		async start() {
			if (!config.notifications || active) return;
			active = true;
			generation += 1;
			const token = generation;
			const current = members.find((member) => member.identity === currentIdentity);
			if (!current) {
				active = false;
				return;
			}
			starting = reconcile(token)
				.then(async () => {
					if (isActive(token)) await broadcast(current, "online");
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
					candidate.identity !== currentIdentity &&
					candidate.identity === hint.member.identity &&
					candidate.name === hint.member.name &&
					candidate.role === hint.member.role,
			);
			if (!member) return false;
			const token = generation;
			if (!state.initialScanComplete) pendingHints.set(member.identity, { member, token });
			else probeHint(member, token);
			return true;
		},
		stop() {
			if (!active) return;
			active = false;
			generation += 1;
			if (timer !== undefined) dependencies.scheduler.cancel(timer);
			timer = undefined;
			scanPromise = undefined;
			pendingHints.clear();
		},
		getState: () => state,
	};
}
