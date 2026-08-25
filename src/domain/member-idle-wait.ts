import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CrewManifest, CrewMember } from "./crew-manifest.ts";

/**
 * Member Idle Wait domain contract (TASK-0050, define-only).
 *
 * Member Idle Wait is a one-shot coordination primitive: a bounded,
 * event-driven wait until another configured member's Pi becomes mechanically
 * idle, goes offline, or the bounded deadline expires. It is distinct from:
 *
 *   - Request outcome waiting (idle never proves a correlated Response);
 *   - Member Status query (an immediate snapshot, not a blocking wait);
 *   - continuous monitoring / background polling (wait is transient, one-shot);
 *   - Presence (endpoint reachability) and availability (never claimed).
 *
 * Idle uses the TASK-0046 mechanical meaning: Pi runtime settled after the
 * active agent run, retry, compaction retry, and queued continuation are
 * exhausted. It does NOT prove the target saw a particular message, finished a
 * task, intends to reply, is healthy/productive/available, or will remain
 * idle. `agent_end` alone is insufficient while retry, compaction, or queued
 * continuation remains — only the `settled` signal (Pi `agent_settled`)
 * completes a busy wait with `idle/became-idle`.
 *
 * The wait is transient and non-durable: it creates no chat activity,
 * history, dashboard, background polling, or automatic follow-up, and it never
 * starts, steers, interrupts, aborts, or sends guidance to the target turn.
 *
 * Transport is not part of this file: reachability probing, the one-shot
 * subscription RPC, and tool registration are TASK-0051. This file defines the
 * pure resolution, timeout bounds, terminal outcome contract, state race, and
 * capacity gate.
 */

export const MEMBER_IDLE_WAIT_TIMEOUT_SECONDS = 1800;
export const MEMBER_IDLE_WAIT_TIMEOUT_MIN_SECONDS = 60;
export const MEMBER_IDLE_WAIT_TIMEOUT_MAX_SECONDS = 7200;
/** Finite per-target subscription capacity; overflow is rejected explicitly. */
export const MAX_MEMBER_IDLE_WAIT_SUBSCRIPTIONS = 8;

const ISO_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const IsoTimestampSchema = Type.String({ pattern: ISO_TIMESTAMP_PATTERN });
const PublicLabelSchema = Type.String({ minLength: 1, maxLength: 256 });

const MemberIdleWaitIdentitySchema = Type.Object(
	{ name: PublicLabelSchema, role: PublicLabelSchema },
	{ additionalProperties: false },
);
const IdleMemberIdleWaitOutcomeSchema = Type.Object(
	{
		outcome: Type.Literal("idle"),
		disposition: Type.Union([Type.Literal("already-idle"), Type.Literal("became-idle")]),
		observedAt: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
const OfflineMemberIdleWaitOutcomeSchema = Type.Object(
	{ outcome: Type.Literal("offline"), observedAt: IsoTimestampSchema },
	{ additionalProperties: false },
);
const TimeoutMemberIdleWaitOutcomeSchema = Type.Object(
	{ outcome: Type.Literal("timeout"), observedAt: IsoTimestampSchema },
	{ additionalProperties: false },
);
const MessageReceivedMemberIdleWaitOutcomeSchema = Type.Object(
	{ outcome: Type.Literal("message-received"), observedAt: IsoTimestampSchema },
	{ additionalProperties: false },
);
const MemberIdleWaitOutcomeSchema = Type.Union([
	IdleMemberIdleWaitOutcomeSchema,
	OfflineMemberIdleWaitOutcomeSchema,
	TimeoutMemberIdleWaitOutcomeSchema,
	MessageReceivedMemberIdleWaitOutcomeSchema,
]);

/**
 * Terminal result contract. Contains only configured name/role, the terminal
 * outcome/disposition, and the observation timestamp. No messages,
 * prompts, tools, session ids, aliases, paths, model data, or instructions.
 */
export const MemberIdleWaitResultSchema = Type.Union([
	Type.Object(
		{
			member: MemberIdleWaitIdentitySchema,
			outcome: Type.Literal("idle"),
			disposition: Type.Union([Type.Literal("already-idle"), Type.Literal("became-idle")]),
			observedAt: IsoTimestampSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			member: MemberIdleWaitIdentitySchema,
			outcome: Type.Literal("offline"),
			observedAt: IsoTimestampSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			member: MemberIdleWaitIdentitySchema,
			outcome: Type.Literal("timeout"),
			observedAt: IsoTimestampSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			member: MemberIdleWaitIdentitySchema,
			outcome: Type.Literal("message-received"),
			observedAt: IsoTimestampSchema,
		},
		{ additionalProperties: false },
	),
]);

export type MemberIdleWaitIdentity = Static<typeof MemberIdleWaitIdentitySchema>;
export type MemberIdleWaitOutcome = Static<typeof MemberIdleWaitOutcomeSchema>;
export type MemberIdleWaitResult = Static<typeof MemberIdleWaitResultSchema>;

/** Outcome as supplied by callers: `observedAt` is applied by the result builder. */
export type MemberIdleWaitOutcomeInput =
	| { readonly outcome: "idle"; readonly disposition: "already-idle" | "became-idle" }
	| { readonly outcome: "offline" }
	| { readonly outcome: "timeout" }
	| { readonly outcome: "message-received" };

const UTF8_ENCODER = new TextEncoder();
const utf8Bytes = (value: string): number => UTF8_ENCODER.encode(value).byteLength;
const isSafeBoundedText = (value: string, limit: number): boolean =>
	value.trim().length > 0 && value === value.trim() && !/[\0\r\n]/u.test(value) && utf8Bytes(value) <= limit;

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !new RegExp(ISO_TIMESTAMP_PATTERN, "u").test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isIdleWaitIdentity(value: MemberIdleWaitIdentity): boolean {
	return isSafeBoundedText(value.name, 256) && isSafeBoundedText(value.role, 256);
}

export function isMemberIdleWaitResult(value: unknown): value is MemberIdleWaitResult {
	if (!Value.Check(MemberIdleWaitResultSchema, value)) return false;
	const result = value as MemberIdleWaitResult;
	return isIdleWaitIdentity(result.member) && isIsoTimestamp(result.observedAt);
}

/**
 * Compact privacy-safe rendering: identity, terminal outcome/disposition, and
 * observation timestamp only. Never exposes messages, session data, or
 * paths (TASK-0050 privacy contract).
 */
export function formatMemberIdleWaitResult(result: MemberIdleWaitResult): string {
	if (!isMemberIdleWaitResult(result)) throw new TypeError("invalid member idle wait result");
	const member = `${result.member.name} (${result.member.role})`;
	if (result.outcome === "idle") return `[${member}] idle — ${result.disposition} at ${result.observedAt}`;
	if (result.outcome === "message-received")
		return `[${member}] message-received at ${result.observedAt} — released because a Bebop message is ready; process it under its delivery mode. No idle or completion claim was made.`;
	return `[${member}] ${result.outcome} at ${result.observedAt}`;
}

export function createMemberIdleWaitResult(
	member: MemberIdleWaitIdentity,
	outcome: MemberIdleWaitOutcomeInput,
	observedAt: string,
): MemberIdleWaitResult {
	const result: MemberIdleWaitResult = { member, ...outcome, observedAt };
	if (!isMemberIdleWaitResult(result)) throw new TypeError("invalid member idle wait result");
	return result;
}

/**
 * Bounded timeout resolution: default 1,800 seconds (30 minutes), accepted
 * range 60-7,200 seconds (TASK-0081 authoritative plan). Timeout is
 * an expected coordination outcome, never task failure.
 */
export function resolveIdleWaitTimeoutSeconds(value: number | undefined): number {
	if (value === undefined) return MEMBER_IDLE_WAIT_TIMEOUT_SECONDS;
	if (
		!Number.isInteger(value) ||
		value < MEMBER_IDLE_WAIT_TIMEOUT_MIN_SECONDS ||
		value > MEMBER_IDLE_WAIT_TIMEOUT_MAX_SECONDS
	)
		throw new TypeError(
			`idle wait timeout must be an integer between ${MEMBER_IDLE_WAIT_TIMEOUT_MIN_SECONDS} and ${MEMBER_IDLE_WAIT_TIMEOUT_MAX_SECONDS}`,
		);
	return value;
}

export type MemberIdleWaitTargetErrorCode = "unknown-member" | "ambiguous-member" | "self-wait" | "not-a-member";

export type MemberIdleWaitTargetResolution =
	| { readonly ok: true; readonly target: CrewMember }
	| { readonly ok: false; readonly code: MemberIdleWaitTargetErrorCode };

/**
 * Resolves the exact configured wait target like member messaging: exact name,
 * or unique role. Roles grant no extra authority: any current joined member may
 * wait for another configured member. Rejects before any network IO.
 */
export function resolveMemberIdleWaitTarget(
	manifest: CrewManifest,
	senderName: string,
	targetLabel: string,
): MemberIdleWaitTargetResolution {
	if (typeof targetLabel !== "string" || targetLabel.trim().length === 0 || targetLabel.includes("\0"))
		return { ok: false, code: "unknown-member" };
	const byName = manifest.members.find((member) => member.name === targetLabel);
	const byRole = manifest.members.filter((member) => member.role === targetLabel);
	const target = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!target) {
		if (byRole.length > 1) return { ok: false, code: "ambiguous-member" };
		return { ok: false, code: "unknown-member" };
	}
	if (target.name === senderName) return { ok: false, code: "self-wait" };
	if (!manifest.members.some((member) => member.name === senderName)) return { ok: false, code: "not-a-member" };
	return { ok: true, target };
}

/** Signals the target runtime may deliver to a waiting subscription. */
export type MemberIdleWaitSignal =
	| { readonly type: "settled" } // Pi agent_settled: retry/compaction/continuation exhausted
	| { readonly type: "agent_end" } // agent_end alone: insufficient while continuation remains
	| { readonly type: "disconnect" } // endpoint went offline/restarted during wait
	| { readonly type: "timeout" } // bounded deadline expired while target remains busy
	| { readonly type: "message" } // accepted Bebop message released the blocked wait (TASK-0081)
	| { readonly type: "cancel" }; // caller cancelled; releases the subscription

export type MemberIdleWaitPhase = "waiting" | "terminal" | "released";

export interface MemberIdleWaitState {
	readonly phase: MemberIdleWaitPhase;
	/** Resolved configured target identity, carried while waiting and in terminal results. */
	readonly target: MemberIdleWaitIdentity;
	readonly result?: MemberIdleWaitResult;
}

interface IdleWaitTransition {
	readonly state: MemberIdleWaitState;
	readonly result?: MemberIdleWaitResult;
	readonly released?: boolean;
}

/**
 * Subscribe-and-snapshot registration. Target atomically registers the
 * one-shot subscription and snapshots `ctx.isIdle()` in one step so an idle
 * transition cannot be lost between separate check/subscribe calls. An
 * already-idle snapshot completes immediately with `idle/already-idle` and
 * never registers a lingering subscription.
 */
export function registerOneShotIdleWait(input: {
	readonly target: MemberIdleWaitIdentity;
	readonly snapshotIsIdle: boolean;
	readonly observedAt: string;
}): IdleWaitTransition {
	if (!isIdleWaitIdentity(input.target)) throw new TypeError("invalid idle wait target identity");
	if (!isIsoTimestamp(input.observedAt)) throw new TypeError("invalid idle wait observation timestamp");
	if (input.snapshotIsIdle) {
		const result = createMemberIdleWaitResult(
			input.target,
			{ outcome: "idle", disposition: "already-idle" },
			input.observedAt,
		);
		return { state: { phase: "terminal", target: input.target, result }, result };
	}
	return { state: { phase: "waiting", target: input.target } };
}

/**
 * Pure one-shot state race. From `waiting`, exactly one terminal outcome wins
 * against settle, disconnect, timeout, and cancellation; `agent_end` alone is
 * insufficient. Later signals on a terminal or released state are no-ops
 * (duplicate terminal events never change the outcome; cancelled waits have no
 * lingering subscription).
 */
export function applyIdleWaitSignal(
	state: MemberIdleWaitState,
	signal: MemberIdleWaitSignal,
	observedAt: string,
): IdleWaitTransition {
	if (!isIsoTimestamp(observedAt)) throw new TypeError("invalid idle wait observation timestamp");
	if (state.phase !== "waiting") return { state, result: state.result, released: false };
	const target = state.target;
	switch (signal.type) {
		case "settled": {
			const result = createMemberIdleWaitResult(
				target,
				{ outcome: "idle", disposition: "became-idle" },
				observedAt,
			);
			return { state: { phase: "terminal", target, result }, result };
		}
		case "agent_end":
			return { state };
		case "disconnect": {
			const result = createMemberIdleWaitResult(target, { outcome: "offline" }, observedAt);
			return { state: { phase: "terminal", target, result }, result };
		}
		case "timeout": {
			const result = createMemberIdleWaitResult(target, { outcome: "timeout" }, observedAt);
			return { state: { phase: "terminal", target, result }, result };
		}
		case "message": {
			const result = createMemberIdleWaitResult(target, { outcome: "message-received" }, observedAt);
			return { state: { phase: "terminal", target, result }, result };
		}
		case "cancel":
			return { state: { phase: "released", target }, released: true };
	}
}

/**
 * Capacity gate (pure, definition-only). Each target enforces finite one-shot
 * subscription capacity and rejects overflow explicitly; a target may also
 * have at most one active wait at a time. The app layer (TASK-0051) owns the
 * active set; this is the decision rule.
 */
export function tryAcquireIdleWaitSubscription(
	activeTargets: ReadonlySet<string>,
	targetName: string,
	activeCount: number,
): { readonly ok: true } | { readonly ok: false; readonly code: "already-waiting" | "capacity-exceeded" } {
	if (activeTargets.has(targetName)) return { ok: false, code: "already-waiting" };
	if (activeCount >= MAX_MEMBER_IDLE_WAIT_SUBSCRIPTIONS) return { ok: false, code: "capacity-exceeded" };
	return { ok: true };
}
