import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveResponsePolicy } from "../domain/index.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import type { Membership } from "../infra/membership-runtime.ts";
import { sendMessageToSocket, type MessageToolResult } from "./send-message.ts";

export interface MemberToolDependencies {
	sendRpcCommand?: typeof sendRpcCommand;
	resolveEndpoint?: (socketPath: string) => Promise<string>;
}

async function resolveMemberEndpoint(socketPath: string): Promise<string> {
	try {
		const target = await fs.readlink(socketPath);
		return path.resolve(path.dirname(socketPath), target);
	} catch {
		return socketPath;
	}
}

const MAX_OUTPUT = 500;

function roleLabel(membership: Membership): string {
	return `${membership.member.name} (${membership.member.role})`;
}

function labelResult(result: MessageToolResult, label: string): MessageToolResult {
	const content = result.content[0];
	if (!content) return result;
	const text = content.text;
	return { ...result, content: [{ type: "text", text: `[${label}] ${text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}...` : text}` }] };
}

export function registerMemberTool(pi: ExtensionAPI, state: SocketState, dependencies: MemberToolDependencies = {}): void {
	const sendRpc = dependencies.sendRpcCommand ?? sendRpcCommand;
	const resolveEndpoint = dependencies.resolveEndpoint ?? resolveMemberEndpoint;
	pi.registerTool({
		name: "send_to_member",
		label: "Send To Member",
		description: "Send a message to a joined crew member role over request-scoped RPC. With allow_reply, one sender_info block lets the recipient call send_to_session back to this sender.",
		parameters: Type.Object({
			member: Type.String({ description: "Crew member name/role" }),
			message: Type.String({ description: "Message to send" }),
			mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("follow_up")], { default: "steer" })),
			wait_until: Type.Optional(Type.Union([Type.Literal("turn_end"), Type.Literal("message_processed"), Type.Literal("off")], { default: "turn_end" })),
			reply_behavior: Type.Optional(Type.Union([Type.Literal("allow_reply"), Type.Literal("end_conversation")])),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const membership = state.membershipRuntime?.getMembership();
			if (!membership) return { content: [{ type: "text", text: "Not joined to a crew" }], isError: true, details: { error: "not-joined" } };
			const targetName = params.member.trim();
			const byName = membership.manifest.members.find((member) => member.name === targetName);
			const byRole = membership.manifest.members.filter((member) => member.role === targetName);
			const target = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
			const label = roleLabel(membership);
			if (!target) {
				const reason = byRole.length > 1 ? `Ambiguous crew role: ${targetName}` : `Unknown crew member: ${targetName}`;
				return { content: [{ type: "text", text: `[${label}] ${reason}` }], isError: true, details: { error: byRole.length > 1 ? "ambiguous-member" : "unknown-member" } };
			}
			if (target.name === membership.member.name || target.socketPath === membership.socketPath) {
				return { content: [{ type: "text", text: `[${label}] Cannot send to yourself` }], isError: true, details: { error: "self-send" } };
			}
			const waitUntil = params.wait_until ?? "turn_end";
			const policy = resolveResponsePolicy(waitUntil, params.reply_behavior);
			if ("error" in policy) return { content: [{ type: "text", text: policy.error }], isError: true, details: { error: policy.error } };
			const targetLabel = `${target.name} (${target.role})`;
			try {
								const result = await sendMessageToSocket({
					socketPath: await resolveEndpoint(target.socketPath),

					message: params.message,
					mode: params.mode ?? "steer",
					policy,
					signal,
					displayTarget: targetLabel,
					deliveryTarget: targetLabel,
					sender: state.context?.sessionManager.getSessionId() ? {
						sessionId: state.context.sessionManager.getSessionId(),
						sessionName: state.context.sessionManager.getSessionName()?.trim() || undefined,
					} : undefined,
				}, sendRpc);
				return labelResult(result, targetLabel);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
				const text = aborted
					? `[${targetLabel}] Member request aborted`
					: `[${targetLabel}] Member endpoint offline: ${message.slice(0, MAX_OUTPUT)}`;
				return { content: [{ type: "text", text }], isError: true, details: { error: aborted ? "aborted" : message } };
			}
		},
	});
}
