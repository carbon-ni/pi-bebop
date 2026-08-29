import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Blocking-wait state and Crew Idle Lock detection (TASK-0117).
 *
 * The marker is the session's own transient, mechanically derived
 * coordination state while a blocking Member Idle Wait or Crew Idle Gate owns
 * the run. It is runtime-owned — never author-supplied — and non-durable:
 * restart begins with no marker. The public snapshot carries only the
 * configured member identity, the wait kind, and the observation time; never
 * a wait target, tool arguments, messages, session ids, or paths.
 *
 * Crew Idle Lock is a mechanical whole-Crew claim (TASK-0116): it exists only
 * while the caller owns an active `crew-idle` gate, the normalized frozen
 * selection covers every other frozen manifest member, and every observed
 * target is online and explicitly in a blocking idle wait. Generic busy,
 * compaction, offline, missing, stale, failed, subset, or absent-marker
 * observations are never lock evidence.
 */

export const MAX_WAIT_STATE_SUBSCRIPTIONS = 8;

const ISO_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !new RegExp(ISO_TIMESTAMP_PATTERN, "u").test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export const BlockingWaitKindSchema = Type.Union([Type.Literal("member-idle"), Type.Literal("crew-idle")]);
export type BlockingWaitKind = Static<typeof BlockingWaitKindSchema>;

export const BlockingWaitMarkerSchema = Type.Object(
	{
		kind: BlockingWaitKindSchema,
		observedAt: Type.String({ pattern: ISO_TIMESTAMP_PATTERN }),
	},
	{ additionalProperties: false },
);
export type BlockingWaitMarker = Static<typeof BlockingWaitMarkerSchema>;

export function isBlockingWaitMarker(value: unknown): value is BlockingWaitMarker {
	if (!Value.Check(BlockingWaitMarkerSchema, value)) return false;
	// Closed schema plus semantic timestamp validity; malformed values are
	// rejected, never repaired.
	return isIsoTimestamp((value as BlockingWaitMarker).observedAt);
}

export interface WaitStateSnapshot {
	readonly member: { readonly name: string; readonly role: string };
	readonly wait: BlockingWaitMarker | null;
}

export const WaitStateSnapshotSchema = Type.Object(
	{
		member: Type.Object(
			{
				name: Type.String({ minLength: 1, maxLength: 256 }),
				role: Type.String({ minLength: 1, maxLength: 256 }),
			},
			{ additionalProperties: false },
		),
		wait: Type.Union([BlockingWaitMarkerSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);

export function isWaitStateSnapshot(value: unknown): value is WaitStateSnapshot {
	if (!Value.Check(WaitStateSnapshotSchema, value)) return false;
	const snapshot = value as WaitStateSnapshot;
	// Closed schema plus bounded trimmed identity and marker semantics.
	const bounded = (text: string) => text.trim().length > 0 && text.trim() === text;
	if (!bounded(snapshot.member.name) || !bounded(snapshot.member.role)) return false;
	return snapshot.wait === null || isBlockingWaitMarker(snapshot.wait);
}

export interface BlockingWaitClock {
	now(): string;
}

export type BlockingWaitSubscription = (marker: BlockingWaitMarker | null) => void;

type SlotAcquire =
	| { readonly ok: true; readonly marker: BlockingWaitMarker }
	| { readonly ok: false; readonly code: "wait-in-progress"; readonly owner: BlockingWaitKind };

/**
 * The single runtime-owned blocking-wait slot. `acquire` happens before any
 * remote IO and rejects any second blocking wait of either kind without
 * replacing or clearing the owner. `release` is exactly-once idempotent.
 * `subscribeOnce` atomically returns the current marker and arms a one-shot
 * listener for the next acquire/release transition, so a transition between a
 * separate check and subscribe can never be lost.
 */
export class BlockingWaitSlot {
	private readonly clock: BlockingWaitClock;
	private active: BlockingWaitMarker | null = null;
	private readonly listeners: BlockingWaitSubscription[] = [];

	constructor(clock: BlockingWaitClock) {
		this.clock = clock;
	}

	acquire(kind: BlockingWaitKind): SlotAcquire {
		if (this.active) return { ok: false, code: "wait-in-progress", owner: this.active.kind };
		const marker: BlockingWaitMarker = { kind, observedAt: this.clock.now() };
		this.active = marker;
		this.publish(marker);
		return { ok: true, marker };
	}

	release(): boolean {
		if (!this.active) return false;
		this.active = null;
		this.publish(null);
		return true;
	}

	activeMarker(): BlockingWaitMarker | null {
		return this.active;
	}

	subscribeOnce(listener: BlockingWaitSubscription): { readonly marker: BlockingWaitMarker | null } {
		const marker = this.active;
		this.listeners.push(listener);
		return { marker };
	}

	private publish(marker: BlockingWaitMarker | null): void {
		if (this.listeners.length === 0) return;
		const listeners = [...this.listeners];
		this.listeners.length = 0;
		for (const listener of listeners) listener(marker);
	}
}

export type WaitStateCallerErrorCode = "unknown-member" | "ambiguous-member" | "self" | "not-a-member";

export type WaitStateCallerResolution =
	| { readonly ok: true; readonly caller: { name: string; role: string } }
	| { readonly ok: false; readonly code: WaitStateCallerErrorCode };

/**
 * Resolves the requesting peer's claimed label against the frozen manifest
 * with member-messaging authority: exact name or unique role, caller must be
 * a configured member other than self. Rejects before any state is exposed.
 */
export function resolveWaitStateCaller(
	manifestMembers: ReadonlyArray<{ name: string; role: string }>,
	ownName: string,
	callerLabel: string,
): WaitStateCallerResolution {
	if (typeof callerLabel !== "string" || callerLabel.trim().length === 0 || callerLabel.includes("\0"))
		return { ok: false, code: "unknown-member" };
	const byName = manifestMembers.find((member) => member.name === callerLabel);
	const byRole = manifestMembers.filter((member) => member.role === callerLabel);
	const caller = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!caller) {
		if (byRole.length > 1) return { ok: false, code: "ambiguous-member" };
		return { ok: false, code: "unknown-member" };
	}
	if (caller.name === ownName) return { ok: false, code: "self" };
	if (!manifestMembers.some((member) => member.name === ownName)) return { ok: false, code: "not-a-member" };
	return { ok: true, caller: { name: caller.name, role: caller.role } };
}

export type WaitStateObservation =
	| { readonly name: string; readonly status: "online"; readonly wait: BlockingWaitMarker | null }
	| { readonly name: string; readonly status: "offline" | "missing" | "stale" | "failed" };

export type CrewIdleLockVerdict =
	| { readonly locked: true }
	| {
			readonly locked: false;
			readonly reason:
				| "caller-not-crew-gate"
				| "selection-subset"
				| "target-missing"
				| "target-offline"
				| "target-stale"
				| "target-failed"
				| "target-not-blocking";
	  };

/**
 * Pure Crew Idle Lock detector. `locked` only when the caller owns an active
 * `crew-idle` marker, the normalized selection set-equals every other frozen
 * manifest member, and every observed target is online with an explicit
 * active blocking-wait marker. Anything else fails safe to a precise reason.
 */
export function detectCrewIdleLock(input: {
	readonly callerWait: BlockingWaitMarker | null;
	readonly callerName: string;
	readonly manifestMembers: ReadonlyArray<{ name: string }>;
	readonly selection: readonly string[];
	readonly observations: readonly WaitStateObservation[];
}): CrewIdleLockVerdict {
	if (input.callerWait?.kind !== "crew-idle") return { locked: false, reason: "caller-not-crew-gate" };
	const others = input.manifestMembers.map((member) => member.name).filter((name) => name !== input.callerName);
	const selectionSet = new Set(input.selection);
	if (selectionSet.size !== input.selection.length || others.length !== input.selection.length)
		return { locked: false, reason: "selection-subset" };
	for (const name of others) if (!selectionSet.has(name)) return { locked: false, reason: "selection-subset" };
	const byName = new Map(input.observations.map((observation) => [observation.name, observation]));
	for (const name of others) {
		const observation = byName.get(name);
		if (!observation) return { locked: false, reason: "target-missing" };
		if (observation.status !== "online") {
			if (observation.status === "offline") return { locked: false, reason: "target-offline" };
			if (observation.status === "stale") return { locked: false, reason: "target-stale" };
			if (observation.status === "failed") return { locked: false, reason: "target-failed" };
			return { locked: false, reason: "target-missing" };
		}
		if (observation.wait === null || !isBlockingWaitMarker(observation.wait))
			return { locked: false, reason: "target-not-blocking" };
	}
	return { locked: true };
}
