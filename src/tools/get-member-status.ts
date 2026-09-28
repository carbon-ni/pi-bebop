import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { BebopClientError, type MemberStatusOperation } from "../sdk/index.ts";
import { formatMemberStatus } from "../domain/index.ts";

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

function errorResult(target: string, code: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: `[${target}] ${message.slice(0, MAX_OUTPUT)}` }],
		isError: true,
		details: { error: code },
	};
}

export function registerGetMemberStatusTool(pi: ExtensionAPI, operation: MemberStatusOperation): void {
	pi.registerTool({
		name: "get_member_status",
		label: "Get Member Status",
		description:
			"Read-only snapshot of one crew member's mechanical Pi runtime state (online/offline reachability, idle/busy/compacting activity, pending-message signal) and the observation time. Activity is mechanical, never verified task progress. The query never starts, steers, or interrupts the target turn. Use send_follow_up when timing does not matter; status is for coordination decisions, not monitoring. When you need intent, progress, a report, or a verdict, ask the member explicitly with send_member_request.",
		parameters,
		async execute(_toolCallId, params, signal) {
			const memberLabel = params.member.trim();
			try {
				const status = await operation.getMemberStatus(memberLabel, { signal });
				return {
					content: [{ type: "text", text: formatMemberStatus(status).slice(0, MAX_OUTPUT) }],
					details: { status },
				};
			} catch (error) {
				if (error instanceof BebopClientError)
					return errorResult(memberLabel || "member", error.code, error.message);
				const message = error instanceof Error ? error.message : "Member status query failed";
				return errorResult(memberLabel || "member", "transport-error", message);
			}
		},
	});
}
