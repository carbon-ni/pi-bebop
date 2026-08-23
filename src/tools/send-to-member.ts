import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import { resolveSessionIdFromAlias } from "../infra/control-store.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import {
	MAX_MESSAGE_INSTRUCTION_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
	MAX_MESSAGE_ORIGIN_FIELD_BYTES,
	isClearResult,
	isExtractedMessage,
	isGetMessageResult,
	resolveResponsePolicy,
} from "../domain/index.ts";
import { resolveSessionTarget, SessionTargetError } from "./session-target.ts";
import { sendMessageToSocket } from "./send-message.ts";

export interface SessionToolState {
	context: ExtensionContext | null;
}

export interface SessionToolDependencies {
	sendRpcCommand?: typeof sendRpcCommand;
	resolveSessionTarget?: typeof resolveSessionTarget;
	loadCrewManifest?: (manifestPath: string) => Promise<import("../domain/index.ts").CrewManifest>;
	readlink?: (socketPath: string) => Promise<string>;
	/** Read at execute time; caller cannot override crew origin. */
	getCurrentCrewOrigin?: () => import("../domain/index.ts").MessageOrigin | undefined;
}

// ============================================================================
// Tool: send_to_member
// ============================================================================

export function registerMemberTool(
	pi: ExtensionAPI,
	state: SessionToolState,
	dependencies: SessionToolDependencies = {},
): void {
	const sendRpc = dependencies.sendRpcCommand ?? sendRpcCommand;

	pi.registerTool({
		name: "send_to_member",
		label: "Send To Member",
		description: `Interact with another crew member via its socket.

Actions:
- send: Send a message (default). Requires 'message' parameter.
- get_message: Get the most recent assistant message.
- clear: Rewind session to initial state.

Target selection:
- socketPath: repository-local crew member socket path (supports a leading @ and relative paths).
- sessionId: UUID of the session.
- sessionName: session name (alias from /name) or project+branch alias shown by list_sessions, e.g. intra-pi-intray-branch-main-1.
- When combined, socketPath must identify the same target as sessionId/sessionName.

Wait behavior (only for action=send):
- wait_until=turn_end: Wait for the turn to complete and return the last assistant message (default synchronous response).
- wait_until=message_processed: Return after the message is queued (use this for callback chat).
- wait_until=off: Confirm delivery without waiting for the target turn (use this for callback chat).
- turn_end cannot be combined with reply_behavior=allow_reply; use end_conversation for synchronous responses.

CLI bridge (for shell scripts/background jobs):
- Current session id is available in shell/bash as $PI_SESSION_ID (set when --intray is enabled).
- Use $PI_SESSION_ID when you need the current session; do not call list_sessions just to discover your own id.
- Target session must be running with --intray.
- One-shot startup send is available via extension flags:
  --intray
  --control-session <session-name|session-id>
  --send-session-message <text>
  --send-session-mode <steer|follow_up> (optional, default: steer)
  --send-session-wait <turn_end|message_processed> (optional)
  --send-session-include-sender-info (optional, advanced; default: off)
- Startup sends are one-way by default (no replyTo), which avoids reply attempts to short-lived 'pi -p' sender sessions.
- If a script needs a response, use --send-session-wait turn_end and read stdout.
- Example script usage (one-way):
  pi -p --intray --control-session "$PI_SESSION_ID" --send-session-message "Background task finished" --send-session-mode follow_up --send-session-wait message_processed
- Example request/response usage:
  pi -p --intray --control-session "$PI_SESSION_ID" --send-session-message "What is the current time?" --send-session-wait turn_end

Response modes are mutually exclusive: turn_end is synchronous and never adds replyTo; use message_processed or off with reply_behavior="allow_reply" for callback chat. allow_reply emits typed replyTo routing independently from claimed origin. Use reply_behavior="end_conversation" for one-way asynchronous messages.`,
		parameters: Type.Object(
			{
				socketPath: Type.Optional(Type.String({ description: "Repository-local crew member socket path" })),
				sessionId: Type.Optional(Type.String({ description: "Target session id (UUID)" })),
				sessionName: Type.Optional(Type.String({ description: "Target session name (alias)" })),
				action: Type.Optional(
					Type.Union([Type.Literal("send"), Type.Literal("get_message"), Type.Literal("clear")], {
						description: "Action to perform (default: send)",
						default: "send",
					}),
				),
				message: Type.Optional(Type.String({ description: "Message to send (required for action=send)" })),
				instructions: Type.Optional(
					Type.Array(Type.String({ minLength: 1, maxLength: MAX_MESSAGE_INSTRUCTION_BYTES }), {
						minItems: 1,
						maxItems: MAX_MESSAGE_INSTRUCTIONS,
						description: "Ordered user-level instructions",
					}),
				),
				from: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: MAX_MESSAGE_ORIGIN_FIELD_BYTES,
						description: "Claimed external label; unavailable when joined",
					}),
				),
				mode: Type.Optional(
					Type.Union([Type.Literal("steer"), Type.Literal("follow_up")], {
						description: "Delivery mode for send: steer (immediate) or follow_up (after task)",
						default: "steer",
					}),
				),
				wait_until: Type.Optional(
					Type.Union([Type.Literal("turn_end"), Type.Literal("message_processed"), Type.Literal("off")], {
						description: "Wait behavior for send action",
						default: "turn_end",
					}),
				),
				reply_behavior: Type.Optional(
					Type.Union([Type.Literal("allow_reply"), Type.Literal("end_conversation")], {
						description:
							"Whether this message should include typed replyTo routing. Omit for a mode-appropriate default; turn_end defaults to end_conversation.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const action = params.action ?? "send";
			const waitUntil = params.wait_until ?? "turn_end";
			const responsePolicy =
				action === "send" ? resolveResponsePolicy(waitUntil, params.reply_behavior) : undefined;
			if (responsePolicy && "error" in responsePolicy) {
				return {
					content: [{ type: "text", text: responsePolicy.error }],
					isError: true,
					details: { error: responsePolicy.error },
				};
			}
			const policy = responsePolicy && "allowsReply" in responsePolicy ? responsePolicy : undefined;
			const executionContext = (_ctx as ExtensionContext | undefined) ?? state.context;
			let target: Awaited<ReturnType<typeof resolveSessionTarget>>;
			try {
				target = await (dependencies.resolveSessionTarget ?? resolveSessionTarget)(
					{
						socketPath: params.socketPath,
						sessionId: params.sessionId,
						sessionName: params.sessionName,
						cwd: executionContext?.cwd ?? process.cwd(),
						isProjectTrusted: () => executionContext?.isProjectTrusted?.() === true,
						currentSessionId: state.context?.sessionManager.getSessionId(),
					},
					{
						resolveAlias: resolveSessionIdFromAlias,
						loadManifest:
							dependencies.loadCrewManifest ??
							(async (manifestPath) => {
								const projectRoot = path.resolve(path.dirname(manifestPath), "..", "..");
								return readTrustedCrewManifest(
									manifestPath,
									projectRoot,
									() => executionContext?.isProjectTrusted?.() === true,
								);
							}),
						readlink: dependencies.readlink,
					},
				);
			} catch (error) {
				const message =
					error instanceof SessionTargetError
						? error.message
						: error instanceof Error
							? error.message
							: "Unable to resolve target";
				return { content: [{ type: "text", text: message }], isError: true, details: { error: message } };
			}

			const socketPath = target.socketPath;
			const targetSessionId = target.sessionId;
			const displayTarget = target.displayTarget;
			const senderSessionId = state.context?.sessionManager.getSessionId();

			try {
				// Handle each action
				if (action === "get_message") {
					const result = await sendRpc(socketPath, { type: "get_message" }, { signal });
					if (!result.response.success) {
						return {
							content: [{ type: "text", text: `Failed: ${result.response.error ?? "unknown error"}` }],
							isError: true,
							details: result,
						};
					}
					if (!isGetMessageResult(result.response.data))
						return {
							content: [{ type: "text", text: "Failed: invalid get_message result" }],
							isError: true,
							details: result,
						};
					const data = result.response.data;
					if (!data.message) {
						return {
							content: [{ type: "text", text: "No assistant message found in session" }],
							details: result,
						};
					}
					return {
						content: [{ type: "text", text: data.message.content }],
						details: { message: data.message },
					};
				}

				if (action === "clear") {
					const result = await sendRpc(socketPath, { type: "clear" }, { timeout: 10000, signal });
					if (!result.response.success) {
						return {
							content: [
								{ type: "text", text: `Failed to clear: ${result.response.error ?? "unknown error"}` },
							],
							isError: true,
							details: result,
						};
					}
					if (!isClearResult(result.response.data))
						return {
							content: [{ type: "text", text: "Failed: invalid clear result" }],
							isError: true,
							details: result,
						};
					const data = result.response.data;
					const msg = data.alreadyAtRoot ? "Session already at root" : "Session cleared";
					return {
						content: [{ type: "text", text: msg }],
						details: data,
					};
				}

				// action === "send"
				if (!params.message || params.message.trim().length === 0) {
					return {
						content: [{ type: "text", text: "Missing message for send action" }],
						isError: true,
						details: { error: "Missing message" },
					};
				}

				const senderSessionName = state.context?.sessionManager.getSessionName()?.trim();
				const currentCrewOrigin = dependencies.getCurrentCrewOrigin?.();
				if (currentCrewOrigin && params.from !== undefined) {
					return {
						content: [{ type: "text", text: "Cannot override joined crew origin with --from" }],
						isError: true,
						details: { error: "origin-override" },
					};
				}
				return await sendMessageToSocket(
					{
						socketPath,
						message: params.message,
						instructions: params.instructions,
						origin:
							currentCrewOrigin ??
							(params.from === undefined ? undefined : { kind: "external", label: params.from }),
						mode: params.mode ?? "steer",
						policy: policy!,
						signal,
						displayTarget: displayTarget || targetSessionId || "session",
						sender: senderSessionId
							? { sessionId: senderSessionId, sessionName: senderSessionName || undefined }
							: undefined,
					},
					sendRpc,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [
						{
							type: "text",
							text: `${params.socketPath ? "Member endpoint offline" : "Failed"}: ${message}`,
						},
					],
					isError: true,
					details: { error: message },
				};
			}
		},

		renderCall(args, theme) {
			const action = args.action ?? "send";
			const sessionRef = args.sessionName ?? args.sessionId ?? "...";
			const shortSessionRef = sessionRef.length > 12 ? sessionRef.slice(0, 8) + "..." : sessionRef;

			// Build the header line
			let header = theme.fg("toolTitle", theme.bold("→ member "));
			header += theme.fg("accent", shortSessionRef);

			// Add action-specific info
			if (action === "send") {
				const mode = args.mode ?? "steer";
				const wait = args.wait_until ?? "turn_end";
				let info = theme.fg("muted", ` (${mode}`);
				if (wait) info += theme.fg("dim", `, wait: ${wait}`);
				info += theme.fg("muted", ")");
				header += info;
			} else {
				header += theme.fg("muted", ` (${action})`);
			}

			// For send action, show the message
			if (action === "send" && args.message) {
				const msg = args.message;
				const preview = msg.length > 80 ? msg.slice(0, 80) + "..." : msg;
				// Handle multi-line messages
				const firstLine = preview.split("\n")[0];
				const hasMore = preview.includes("\n") || msg.length > 80;
				return new Text(header + "\n  " + theme.fg("dim", `"${firstLine}${hasMore ? "..." : ""}"`), 0, 0);
			}

			return new Text(header, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as Record<string, unknown> | undefined;
			const isError = (result as { isError?: boolean }).isError === true;

			// Error case
			if (isError || details?.error) {
				const errorMsg =
					(details?.error as string) || result.content[0]?.type === "text"
						? (result.content[0] as { type: "text"; text: string }).text
						: "Unknown error";
				return new Text(theme.fg("error", "✗ ") + theme.fg("error", errorMsg), 0, 0);
			}

			// Detect action from details structure
			const hasMessage = details && "message" in details && details.message;
			const hasCleared = details && "cleared" in details;
			const hasTurnIndex = details && "turnIndex" in details;

			// get_message or turn_end result with message
			if (hasMessage) {
				if (!isExtractedMessage(details.message))
					return new Text(theme.fg("error", "✗ Invalid message payload"), 0, 0);
				const message = details.message;
				const icon = theme.fg("success", "✓");

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(icon + theme.fg("muted", " Message received"), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(message.content, 0, 0, getMarkdownTheme()));
					if (hasTurnIndex) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Turn #${details.turnIndex}`), 0, 0));
					}
					return container;
				}

				// Collapsed view - show preview
				const preview = message.content.length > 200 ? message.content.slice(0, 200) + "..." : message.content;
				const lines = preview.split("\n").slice(0, 5);
				let text = icon + theme.fg("muted", " Message received");
				if (hasTurnIndex) text += theme.fg("dim", ` (turn #${details.turnIndex})`);
				text += "\n" + theme.fg("toolOutput", lines.join("\n"));
				if (message.content.split("\n").length > 5 || message.content.length > 200) {
					text += "\n" + theme.fg("dim", "(Ctrl+O to expand)");
				}
				return new Text(text, 0, 0);
			}

			// clear result
			if (hasCleared) {
				const alreadyAtRoot = details.alreadyAtRoot as boolean | undefined;
				const icon = theme.fg("success", "✓");
				const msg = alreadyAtRoot ? "Session already at root" : "Session cleared";
				return new Text(icon + " " + theme.fg("muted", msg), 0, 0);
			}

			// send result (no wait or message_processed)
			if (details && "delivered" in details) {
				const mode = details.mode as string | undefined;
				const icon = theme.fg("success", "✓");
				let text = icon + theme.fg("muted", " Message delivered");
				if (mode) text += theme.fg("dim", ` (${mode})`);
				return new Text(text, 0, 0);
			}

			// Fallback - just show the text content
			const text = result.content[0];
			const content = text?.type === "text" ? text.text : "(no output)";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", content), 0, 0);
		},
	});
}
