import { access, writeFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { durableSocketPath, openDurableMember } from "./member.ts";
import { runMemberServer } from "./server.ts";

const [storagePath, workspacePath, markerPath] = process.argv.slice(2);
if (!storagePath || !workspacePath || !markerPath) throw new Error("storage, workspace, and marker paths are required");

const faux = fauxProvider();
const response: FauxResponseFactory = (context) => {
	if (context.messages.some((message) => message.role === "toolResult" && !message.isError))
		return fauxAssistantMessage("Recovered result");
	const hasRecoveryInput = context.messages.some((message) =>
		message.role === "user" && JSON.stringify(message.content).includes("Read the notes"),
	);
	return hasRecoveryInput
		? fauxAssistantMessage(fauxToolCall("read_file", { path: "notes.txt" }), { stopReason: "toolUse" })
		: fauxAssistantMessage("Seeded prior state");
};
faux.setResponses(Array.from({ length: 20 }, () => response));
const member = await openDurableMember({
	storagePath,
	memberId: "designer",
	modelId: faux.getModel().id,
	workspacePath,
	provider: faux.provider,
	readFile: async () => {
		if (process.env.BLOCK_MEMBER_READ === "1") {
			try { await access(markerPath); }
			catch {
				await writeFile(markerPath, "tool reached", { mode: 0o600 });
				await new Promise<void>(() => undefined);
			}
		}
		return "persisted source notes";
	},
});
await runMemberServer({
	socketPath: await durableSocketPath(storagePath),
	memberId: "designer",
	conversationId: member.conversationId,
	member,
});
