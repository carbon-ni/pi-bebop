import { resolveMemberEndpoint } from "./socket-endpoint.ts";
import { sendMemberIdleWait } from "./rpc-client.ts";
import { sendMemberWaitState } from "./wait-state-client.ts";
import type { MemberStatusTransport } from "./member-status-transport.ts";
import type { CrewIdleMember, WaitStateSnapshot, MemberStatus } from "../domain/index.ts";

export type CrewIdleWaitTransportStatus =
	| { readonly ok: true; readonly status: MemberStatus }
	| { readonly ok: false; readonly code: string };
export type CrewIdleWaitTransportState =
	| { readonly ok: true; readonly snapshot: WaitStateSnapshot }
	| { readonly ok: false; readonly code: string };
export type CrewIdleWaitTransportIdle =
	| { readonly ok: true; readonly outcome: "became-idle" | "already-idle" | "message-received" }
	| { readonly ok: false; readonly code: string };

export interface CrewIdleWaitTransport {
	readonly requestStatus: (member: CrewIdleMember, signal: AbortSignal) => Promise<CrewIdleWaitTransportStatus>;
	readonly requestWaitState: (
		member: CrewIdleMember,
		options: { signal: AbortSignal; onTransition: (snapshot: WaitStateSnapshot) => void },
	) => Promise<CrewIdleWaitTransportState>;
	readonly requestMemberIdle: (
		member: CrewIdleMember,
		options: { timeoutSeconds: number; signal: AbortSignal },
	) => Promise<CrewIdleWaitTransportIdle>;
}

/** Strict remote transport for the Crew Idle Gate. Labels come from the
 * frozen manifest; the current member is the only caller identity sent over
 * wait-state RPC. No messages, prompts, paths, or session identifiers cross
 * the application seam. */
export function createCrewIdleWaitTransport(input: {
	readonly getCurrentMember: () => CrewIdleMember | null;
	readonly status: MemberStatusTransport;
}): CrewIdleWaitTransport {
	return {
		requestStatus: (member, signal) => input.status.requestStatus(member.socketPath, member.name, signal),
		requestWaitState: async (member, options) => {
			try {
				const caller = input.getCurrentMember();
				if (!caller) return { ok: false, code: "not-joined" };
				const endpoint = await resolveMemberEndpoint(member.socketPath);
				return await sendMemberWaitState(endpoint, { type: "wait_state", member: caller.name }, options);
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
				return { ok: false, code: "transport-error" };
			}
		},
		requestMemberIdle: async (member, options) => {
			try {
				const endpoint = await resolveMemberEndpoint(member.socketPath);
				const outcome = await sendMemberIdleWait(
					endpoint,
					{ type: "member_idle_wait", member: member.name },
					options,
				);
				if ("result" in outcome) {
					if (outcome.result.outcome === "idle") return { ok: true, outcome: outcome.result.disposition };
					if (outcome.result.outcome === "message-received") return { ok: true, outcome: "message-received" };
					if (outcome.result.outcome === "timeout") return { ok: false, code: "timeout" };
					return { ok: false, code: "transport-error" };
				}
				if (outcome.code === "offline") return { ok: false, code: "offline" };
				if (outcome.code === "transport-error" && outcome.transportCode) return { ok: false, code: "offline" };
				return { ok: false, code: outcome.code };
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
				return { ok: false, code: "transport-error" };
			}
		},
	};
}
