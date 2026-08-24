import { sendRpcCommand } from "./rpc-client.ts";
import { resolveMemberEndpoint } from "./socket-endpoint.ts";
import { probeMemberEndpoint } from "./member-endpoint.ts";
import { isMemberStatusResult, type MemberStatus } from "../domain/index.ts";
import type { MemberStatusFlowErrorCode } from "../application/member-status-flow.ts";

/**
 * Shared member-status transport (TASK-0061): the exact dependencies the
 * in-agent tool uses, factored so the CLI-delegated server path and the tool
 * registration stay identical. Finite endpoint reachability probe plus one
 * `member.status` RPC with a bounded target label and a 5-second deadline.
 *
 * Cancellation (TASK-0061 QA): every call accepts an optional AbortSignal.
 * The CLI passes its own signal to its RPC; when the CLI disconnects, the
 * server aborts the in-flight probe/RPC through the same signal, so a
 * cancelled CLI cannot leave the target probe or status RPC running.
 */
export interface MemberStatusTransport {
	readonly probeEndpoint: (socketPath: string, signal?: AbortSignal) => Promise<boolean>;
	readonly requestStatus: (
		endpoint: string,
		memberLabel: string,
		signal?: AbortSignal,
	) => Promise<{ ok: true; status: MemberStatus } | { ok: false; code: MemberStatusFlowErrorCode }>;
}

export function createMemberStatusTransport(probeTimeoutMs = 300): MemberStatusTransport {
	return {
		probeEndpoint: (socketPath, signal) => probeMemberEndpoint(socketPath, { timeoutMs: probeTimeoutMs, signal }),
		requestStatus: async (endpoint, memberLabel, signal) => {
			try {
				const resolved = await resolveMemberEndpoint(endpoint);
				const { response } = await sendRpcCommand(
					resolved,
					{ type: "member_status", member: memberLabel },
					{ timeout: 5000, signal },
				);
				if (!response.success)
					return { ok: false, code: response.error === "timeout" ? "timeout" : "remote-rejected" };
				if (!isMemberStatusResult(response.data)) return { ok: false, code: "malformed-response" };
				return { ok: true, status: response.data.status };
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
				const message = error instanceof Error ? error.message : "";
				if (/timed? ?out|timeout/i.test(message)) return { ok: false, code: "timeout" };
				return { ok: false, code: "transport-error" };
			}
		},
	};
}
