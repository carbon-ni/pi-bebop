import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	createMemberStatusFlow,
	MemberStatusFlowError,
	type MemberStatusSurface,
} from "../application/member-status-flow.ts";
import type { SocketState } from "../pi/control-runtime.ts";

const parameters = Type.Object(
	{
		action: Type.Union([Type.Literal("set"), Type.Literal("clear")], {
			description: "set publishes or replaces your Focus; clear removes it",
		}),
		focus: Type.Optional(
			Type.String({
				minLength: 1,
				description: "One short single-line crew-visible note (required only for set)",
			}),
		),
	},
	{ additionalProperties: false },
);
const MAX_OUTPUT = 500;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };

export function registerUpdateMemberFocusTool(pi: ExtensionAPI, state: SocketState): void {
	pi.registerTool({
		name: "update_member_focus",
		label: "Update Member Focus",
		description:
			"Publish or clear your own short crew-visible Focus note (set|clear). Focus is self-reported and unverified, never a claim of task progress; it is visible to crew members via get_member_status. Never publish secrets, credentials, private prompt content, customer data, or filesystem paths. Focus mutates only your local session state and performs no network calls.",
		parameters,
		async execute(_toolCallId, params): Promise<ToolResult> {
			const membership = state.membershipRuntime?.getMembership() ?? null;
			if (!membership)
				return {
					content: [{ type: "text", text: "[focus] Not joined to a crew" }],
					isError: true,
					details: { error: "not-joined" },
				};
			const action = params.action as "set" | "clear";
			const focus = typeof params.focus === "string" ? params.focus : undefined;
			const surface: MemberStatusSurface = {
				getMembership: () => state.membershipRuntime?.getMembership() ?? null,
				isTrusted: () => state.context?.isProjectTrusted?.() === true,
				isIdle: () => false,
				hasPendingMessages: () => false,
				getEntries: () => state.context?.sessionManager?.getEntries?.() ?? ([] as unknown[]),
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				probeEndpoint: async () => true,
				requestStatus: async () => ({ ok: false, code: "transport-error" }),
				now: () => new Date().toISOString(),
			};
			const flow = createMemberStatusFlow(surface);
			try {
				const result = await flow.updateFocus(action, focus);
				if (result.state === "reported")
					return {
						content: [{ type: "text", text: `Focus (member-reported): ${result.text}` }],
						details: { focus: result },
					};
				return {
					content: [{ type: "text", text: "Focus cleared (unspecified)" }],
					details: { focus: result },
				};
			} catch (error) {
				if (error instanceof MemberStatusFlowError)
					return {
						content: [{ type: "text", text: `[focus] ${error.message}` }],
						isError: true,
						details: { error: error.code },
					};
				return {
					content: [{ type: "text", text: "[focus] Focus update failed" }],
					isError: true,
					details: { error: "invalid-focus" },
				};
			}
		},
	});
}
