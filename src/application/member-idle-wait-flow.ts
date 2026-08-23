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

export function createMemberIdleWaitFlow(surface: MemberIdleWaitSurface) {
	const waitForMemberIdle = async (input: {
		member: string;
		timeoutSeconds?: number;
		signal?: AbortSignal;
	}): Promise<MemberIdleWaitResult> => {
		const membership = requireJoined(surface);
		let timeoutSeconds: number;
		try {
			timeoutSeconds = resolveIdleWaitTimeoutSeconds(input.timeoutSeconds);
		} catch {
			throw new MemberIdleWaitFlowError(
				"invalid-timeout",
				"Idle wait timeout must be an integer between 1 and 600",
			);
		}
		const memberLabel = input.member.trim();
		const resolution = resolveMemberIdleWaitTarget(membership.manifest, membership.member.name, memberLabel);
		if (resolution.ok === false)
			throw new MemberIdleWaitFlowError(resolution.code, `Idle wait target rejected: ${resolution.code}`);
		const target = resolution.target;
		const observedAt = surface.now();

		// Reachability is the offline boundary: failure is a compact offline result.
		const alive = await surface.probeEndpoint(target.socketPath);
		if (!alive)
			return createMemberIdleWaitResult(
				{ name: target.name, role: target.role },
				{ outcome: "offline" },
				observedAt,
			);

		const outcome = await surface.requestIdleWait(target.socketPath, memberLabel, {
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

	return { waitForMemberIdle };
}
