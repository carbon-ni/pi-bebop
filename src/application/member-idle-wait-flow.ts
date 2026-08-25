import {
	createMemberIdleWaitResult,
	resolveIdleWaitTimeoutSeconds,
	resolveMemberIdleWaitTarget,
	type CrewManifest,
	type MemberIdleWaitResult,
} from "../domain/index.ts";

/**
 * Member Idle Wait application flow (TASK-0051).
 *
 * Request-scoped operation: resolve the exact configured target through the
 * current membership, validate the bounded timeout, probe reachability, open a
 * one-shot idle subscription, and map the terminal outcome (idle, offline, or
 * timeout) or a deterministic error. The Pi surface is injected so this stays
 * free of Pi types and socket details.
 *
 * The wait never starts, steers, interrupts, aborts, or sends guidance to the
 * target turn. Offline and timeout are normal expected coordination outcomes,
 * never task failure. Timeout is caller-enforced via the injected transport;
 * the flow maps a `timeout` transport outcome to the closed timeout result.
 */

export type MemberIdleWaitFlowErrorCode =
	| "not-joined"
	| "untrusted"
	| "unknown-member"
	| "ambiguous-member"
	| "self-wait"
	| "not-a-member"
	| "invalid-timeout"
	| "timeout"
	| "offline"
	| "aborted"
	| "malformed-response"
	| "remote-rejected"
	| "capacity-exceeded"
	| "wait-in-progress"
	| "transport-error";

export class MemberIdleWaitFlowError extends Error {
	readonly code: MemberIdleWaitFlowErrorCode;

	constructor(code: MemberIdleWaitFlowErrorCode, message: string) {
		super(message);
		this.name = "MemberIdleWaitFlowError";
		this.code = code;
	}
}

export type MemberIdleWaitTransportResult =
	| { readonly ok: true; readonly result: MemberIdleWaitResult }
	| {
			readonly ok: false;
			readonly code:
				| "timeout"
				| "offline"
				| "aborted"
				| "malformed-response"
				| "remote-rejected"
				| "capacity-exceeded"
				| "wait-in-progress"
				| "transport-error";
	  };

type CrewMember = { name: string; role: string; socketPath: string };
type CrewMembership = { member: CrewMember; socketPath: string; manifest: CrewManifest };

export interface MemberIdleWaitSurface {
	readonly getMembership: () => CrewMembership | null;
	readonly isTrusted: () => boolean;
	/** Finite-time endpoint reachability; failure is a compact offline result, never an error. */
	readonly probeEndpoint: (socketPath: string) => Promise<boolean>;
	/** Open the one-shot idle subscription and block until a terminal outcome or transport code. */
	readonly requestIdleWait: (
		endpoint: string,
		memberLabel: string,
		options: { timeoutSeconds: number; signal?: AbortSignal },
	) => Promise<MemberIdleWaitTransportResult>;
	readonly now: () => string;
}

function requireJoined(surface: MemberIdleWaitSurface): CrewMembership {
	const membership = surface.getMembership();
	if (!membership) throw new MemberIdleWaitFlowError("not-joined", "Not joined to a crew");
	if (!surface.isTrusted()) throw new MemberIdleWaitFlowError("untrusted", "Project is not trusted");
	return membership;
}

export type PreparedMemberIdleWait =
	| { readonly kind: "ready"; readonly target: CrewMember; readonly timeoutSeconds: number }
	| { readonly kind: "offline"; readonly target: CrewMember };

export type ResolvedMemberIdleWait = {
	readonly kind: "ready";
	readonly target: CrewMember;
	readonly timeoutSeconds: number;
};

export function createMemberIdleWaitFlow(surface: MemberIdleWaitSurface) {
	/**
	 * TASK-0081: pure, synchronous target/timeout resolution with NO IO. The
	 * tool acquires the single local blocking-idle-wait slot AFTER this step and
	 * BEFORE the reachability probe, so a concurrent second wait fails with
	 * `wait-in-progress` before any IO (never shares, replaces, or opens a
	 * subscription). Throws the same deterministic flow errors as prepare.
	 */
	const resolveMemberIdleWait = (input: { member: string; timeoutSeconds?: number }): ResolvedMemberIdleWait => {
		const membership = requireJoined(surface);
		let timeoutSeconds: number;
		try {
			timeoutSeconds = resolveIdleWaitTimeoutSeconds(input.timeoutSeconds);
		} catch {
			throw new MemberIdleWaitFlowError(
				"invalid-timeout",
				"Idle wait timeout must be an integer between 60 and 7200",
			);
		}
		const memberLabel = input.member.trim();
		const resolution = resolveMemberIdleWaitTarget(membership.manifest, membership.member.name, memberLabel);
		if (resolution.ok === false)
			throw new MemberIdleWaitFlowError(resolution.code, `Idle wait target rejected: ${resolution.code}`);
		return { kind: "ready", target: resolution.target, timeoutSeconds };
	};

	/**
	 * TASK-0077/0081: validate and probe without ever blocking on the
	 * subscription. Reachability failure is a compact offline outcome; success
	 * arms the blocking wait (the tool opens the one-shot subscription and
	 * stays pending until a terminal outcome or accepted message).
	 */
	const prepareMemberIdleWait = async (input: {
		member: string;
		timeoutSeconds?: number;
	}): Promise<PreparedMemberIdleWait> => {
		const resolved = resolveMemberIdleWait(input);
		const target = resolved.target;

		// Reachability is the offline boundary: failure is a compact offline result.
		const alive = await surface.probeEndpoint(target.socketPath);
		if (!alive) return { kind: "offline", target };
		return { kind: "ready", target, timeoutSeconds: resolved.timeoutSeconds };
	};

	const waitForMemberIdle = async (input: {
		member: string;
		timeoutSeconds?: number;
		signal?: AbortSignal;
	}): Promise<MemberIdleWaitResult> => {
		const prepared = await prepareMemberIdleWait(input);
		if (prepared.kind === "offline")
			return createMemberIdleWaitResult(
				{ name: prepared.target.name, role: prepared.target.role },
				{ outcome: "offline" },
				surface.now(),
			);
		const { target, timeoutSeconds } = prepared;
		const observedAt = surface.now();

		const outcome = await surface.requestIdleWait(target.socketPath, input.member.trim(), {
			timeoutSeconds,
			signal: input.signal,
		});
		if (outcome.ok === false) {
			switch (outcome.code) {
				case "timeout":
					return createMemberIdleWaitResult(
						{ name: target.name, role: target.role },
						{ outcome: "timeout" },
						surface.now(),
					);
				case "offline":
					return createMemberIdleWaitResult(
						{ name: target.name, role: target.role },
						{ outcome: "offline" },
						surface.now(),
					);
				default:
					throw new MemberIdleWaitFlowError(outcome.code, `Member idle wait failed: ${outcome.code}`);
			}
		}
		const result = outcome.result;
		if (result.member.name !== target.name || result.member.role !== target.role)
			throw new MemberIdleWaitFlowError(
				"malformed-response",
				"Member returned an idle wait result for a different identity",
			);
		return result;
	};

	return { waitForMemberIdle, prepareMemberIdleWait, resolveMemberIdleWait };
}
