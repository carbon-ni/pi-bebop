import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	createMemberStatusFlow,
	MemberStatusFlowError,
	type MemberStatusFlowErrorCode,
	type MemberStatusSurface,
} from "../application/member-status-flow.ts";
import { formatMemberStatus, type MemberStatus } from "../domain/index.ts";
import type { SocketState } from "../pi/control-runtime.ts";

const parameters = Type.Object(
	{
		member: Type.String({
			minLength: 1,
			description: "Crew member name or unique role to query (exact name when role is ambiguous)",
		}),
	},
	{ additionalProperties: false },
);
const MAX_OUTPUT = 800;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

export interface MemberStatusToolTransport {
	/** Finite-time endpoint reachability; failure is a compact offline result. */
	readonly probeEndpoint: (socketPath: string) => Promise<boolean>;
	readonly requestStatus: (
		endpoint: string,
		memberLabel: string,
	) => Promise<{ ok: true; status: MemberStatus } | { ok: false; code: MemberStatusFlowErrorCode }>;
}

function errorResult(target: string, code: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: `[${target}] ${message.slice(0, MAX_OUTPUT)}` }],
		isError: true,
		details: { error: code },
	};
}

export function registerGetMemberStatusTool(
	pi: ExtensionAPI,
	state: SocketState,
	transport: MemberStatusToolTransport,
): void {
	pi.registerTool({
		name: "get_member_status",
		label: "Get Member Status",
		description:
			"Read-only snapshot of one crew member's mechanical Pi runtime state (online/offline reachability, idle/busy activity, pending-message signal) and their self-reported Focus note. Activity is mechanical and Focus is member-reported, never verified task progress. The query never starts, steers, or interrupts the target turn. Use send_follow_up when timing does not matter; status is for coordination decisions, not monitoring.",
		parameters,
		async execute(_toolCallId, params) {
			const membership = state.membershipRuntime?.getMembership() ?? null;
			if (!membership) return errorResult("member", "not-joined", "Not joined to a crew");
			const memberLabel = params.member.trim();
			const surface: MemberStatusSurface = {
				getMembership: () => state.membershipRuntime?.getMembership() ?? null,
				isTrusted: () => state.context?.isProjectTrusted?.() === true,
				isIdle: () => false,
				hasPendingMessages: () => false,
				getEntries: () => [],
				appendEntry: () => undefined,
				probeEndpoint: (socketPath) => transport.probeEndpoint(socketPath),
				requestStatus: (socketPath, label) => transport.requestStatus(socketPath, label),
				now: () => new Date().toISOString(),
			};
			const flow = createMemberStatusFlow(surface);
			try {
				const status = await flow.queryStatus(memberLabel);
				return {
					content: [{ type: "text", text: formatMemberStatus(status).slice(0, MAX_OUTPUT) }],
					details: { status },
				};
			} catch (error) {
				if (error instanceof MemberStatusFlowError)
					return errorResult(memberLabel || "member", error.code, error.message);
				const message = error instanceof Error ? error.message : "Member status query failed";
				return errorResult(memberLabel || "member", "transport-error", message);
			}
		},
	});
}
