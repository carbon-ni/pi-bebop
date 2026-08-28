import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MessagePayloadSchema } from "../domain/index.ts";
import { MemberMessageError } from "../application/member-message.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { isInterruptResult, isMessagePayload, type MessagePayload } from "../domain/index.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import type { CrewMember } from "../domain/index.ts";
import { actionableToolError, type ActionableToolResult } from "./actionable-tool-result.ts";

const parameters = Type.Object(
	{
		member: Type.String({ minLength: 1, description: "Crew member name or unique role to interrupt" }),
		message: Type.String({ minLength: 1, description: "Recovery guidance for the interrupted member" }),
		instructions: MessagePayloadSchema.properties.instructions,
	},
	{ additionalProperties: false },
);
interface MembershipLike {
	member: CrewMember;
	socketPath: string;
	manifest: { members: readonly CrewMember[] };
}

function resolveTarget(membership: MembershipLike, memberName: string): CrewMember {
	const byName = membership.manifest.members.find((member) => member.name === memberName);
	const byRole = membership.manifest.members.filter((member) => member.role === memberName);
	const target = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!target) {
		if (byRole.length > 1) throw new MemberMessageError("ambiguous-member", `Ambiguous crew role: ${memberName}`);
		throw new MemberMessageError("unknown-member", `Unknown crew member: ${memberName}`);
	}
	if (target.name === membership.member.name || target.socketPath === membership.socketPath)
		throw new MemberMessageError("self-send", "Cannot interrupt yourself");
	return target;
}

const REMOTE_ERROR_CODES = new Set([
	"aborted",
	"abort-failed",
	"already-pending",
	"ambiguous-member",
	"invalid-ack",
	"invalid-payload",
	"handoff-failed",
	"no-context",
	"not-joined",
	"offline",
	"remote-rejected",
	"self-send",
	"timeout",
	"outcome-unknown",
	"unknown-member",
]);

export function normalizeInterruptErrorCode(code: string | undefined): string {
	return code && REMOTE_ERROR_CODES.has(code) ? code : "unexpected-failure";
}

function errorResult(target: string, code: string, _message: string): ActionableToolResult {
	code = normalizeInterruptErrorCode(code);
	const reason =
		code === "ambiguous-member"
			? "Ambiguous member target"
			: code === "unknown-member"
				? "Unknown member target"
				: code === "self-send"
					? "the target is yourself"
					: code === "not-joined"
						? "Not joined to a crew"
						: code === "invalid-payload"
							? "the interrupt payload is invalid"
							: code === "invalid-ack"
								? "the member returned an invalid interrupt acknowledgement"
								: code === "offline"
									? "the member endpoint is offline"
									: "the interrupt operation was rejected";
	return actionableToolError({
		code,
		operation: "interrupt_member",
		reason,
		recovery: ["verify crew membership and the target, then retry the tool."],
		location: { kind: "member", name: "member", value: target },
	});
}

export function registerInterruptMemberTool(pi: ExtensionAPI, state: SocketState): void {
	pi.registerTool({
		name: "interrupt_member",
		label: "Interrupt Member",
		description:
			"Hard-interrupt another crew member's active work and deliver recovery guidance before any queued follow-ups. Use ONLY to stop or recover work that is stuck, harmful, or based on invalid assumptions; for normal urgency use redirect_member or send_follow_up. The target must be online. Abort is best-effort and never rolls back filesystem, shell, network, or already-completed side effects.",
		parameters,
		async execute(_toolCallId, params) {
			const membership = state.membershipRuntime?.getMembership() ?? null;
			if (!membership) return errorResult("member", "not-joined", "Not joined to a crew");
			const targetName = params.member.trim();
			try {
				const target = resolveTarget(membership as never, targetName);
				const payload: MessagePayload = {
					content: params.message,
					...(params.instructions === undefined ? {} : { instructions: [...params.instructions] }),
					origin: { kind: "crew", name: membership.member.name, role: membership.member.role },
				};
				if (!isMessagePayload(payload))
					return errorResult(targetName, "invalid-payload", "Invalid interrupt payload");
				const endpoint = await resolveMemberEndpoint(target.socketPath);
				const { response } = await sendRpcCommand(endpoint, { type: "interrupt", payload }, { timeout: 5000 });
				if (!response.success)
					return errorResult(
						targetName,
						response.error ?? "remote-rejected",
						response.error ?? "Member rejected interrupt",
					);
				const data = response.data;
				if (!isInterruptResult(data))
					return errorResult(
						targetName,
						"invalid-ack",
						"Member returned an invalid interrupt acknowledgement",
					);
				const dispositionText =
					data.disposition === "interrupt-requested"
						? "abort requested; recovery queued ahead of follow-ups"
						: "idle; recovery delivered directly";
				return {
					content: [
						{
							type: "text",
							text: `[${target.name} (${target.role})] ${dispositionText} (${data.interruptId})`,
						},
					],
					details: { interruptId: data.interruptId, disposition: data.disposition },
				};
			} catch (error) {
				if (error instanceof MemberMessageError)
					return errorResult(targetName || "member", error.code, error.message);
				const message = error instanceof Error ? error.message : "Member endpoint offline";
				return errorResult(targetName || "member", "offline", `Member endpoint offline: ${message}`);
			}
		},
	});
}
