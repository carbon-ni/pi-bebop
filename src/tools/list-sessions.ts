import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { filterSessionsBySearch } from "../domain/index.ts";
import { getLiveSessions } from "../infra/control-store.ts";

export function registerListSessionsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "list_sessions",
		label: "List Sessions",
		description: "List live sessions that expose an intray socket, including session-name and git-branch aliases when available. Optionally filter by part of the session id, session name, or alias. Use this for discovery only; for the current session id in shell/bash use $PI_SESSION_ID.",
		parameters: Type.Object({
			search: Type.Optional(Type.String({ description: "Case-insensitive text to match against session id, session name, or aliases" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const search = params.search?.trim();
			const allSessions = await getLiveSessions();
			const sessions = filterSessionsBySearch(allSessions, search);

			if (sessions.length === 0) {
				return {
					content: [{ type: "text", text: search ? `No live sessions found matching "${search}".` : "No live sessions found." }],
					details: { sessions: [], search: search ?? null },
				};
			}

			const lines = sessions.map((session) => {
				const aliases = session.aliases.length > 0 ? ` (${session.aliases.join(", ")})` : "";
				return `- ${session.sessionId}${aliases}`;
			});

			return {
				content: [{ type: "text", text: `${search ? `Live sessions matching "${search}"` : "Live sessions"}:\n${lines.join("\n")}` }],
				details: { sessions, search: search ?? null },
			};
		},
	});
}
