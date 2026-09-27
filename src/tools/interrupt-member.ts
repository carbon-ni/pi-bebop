import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import { BebopClientError, type MemberInterruptOperation } from "../sdk/index.ts";

const parameters = Type.Object(
	{
		member: Type.String({ minLength: 1, description: "Crew member name or unique role to interrupt" }),
		message: Type.String({ minLength: 1, description: "Recovery guidance for the interrupted member" }),
		instructions: MessagePayloadSchema.properties.instructions,
	},
	{ additionalProperties: false },
);
const MAX_OUTPUT = 500;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

function errorResult(target: string, code: string, message: string): ToolResult {
	return {
		content: [{ type: "text", text: `[${target}] ${message.slice(0, MAX_OUTPUT)}` }],
		isError: true,
		details: { error: code },
	};
}

export function registerInterruptMemberTool(pi: ExtensionAPI, operation: MemberInterruptOperation): void {
	pi.registerTool({
		name: "interrupt_member",
		label: "Interrupt Member",
		description:
			"Hard-interrupt another crew member's active work and deliver recovery guidance before any queued follow-ups. Use ONLY to stop or recover work that is stuck, harmful, or based on invalid assumptions; for normal urgency use redirect_member or send_follow_up. The target must be online. Abort is best-effort and never rolls back filesystem, shell, network, or already-completed side effects.",
		parameters,
		async execute(_toolCallId, params) {
			const targetName = params.member.trim();
			try {
				const result = await operation.interruptMember(targetName, {
					message: params.message,
					...(params.instructions === undefined ? {} : { instructions: [...params.instructions] }),
				});
				const dispositionText =
					result.disposition === "interrupt-requested"
						? "abort requested best-effort; recovery queued ahead of follow-ups"
						: "idle; recovery delivered directly";
				return {
					content: [
						{
							type: "text",
							text: `[${result.member.name} (${result.member.role})] ${dispositionText} (${result.interruptId})`,
						},
					],
					details: { interruptId: result.interruptId, disposition: result.disposition },
				};
			} catch (error) {
				if (error instanceof BebopClientError)
					return errorResult(targetName || "member", error.code, error.message);
				return errorResult(
					targetName || "member",
					"transport-error",
					"Interrupt failed due to a transport error",
				);
			}
		},
	});
}
