import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionFiles = [
	"extension.ts",
	"pi/control-runtime.ts",
	"pi/inbox-bridge-runtime.ts",
	"pi/command-handlers/send.ts",
	"pi/command-handlers/member-request.ts",
	"pi/command-handlers/interrupt.ts",
];

const requiredModelSurfaces = [
	"pi/command-handlers/send.ts", // Follow-up, Redirect, Request, Inbox, Broadcast, Intake, and Crew ingress.
	"pi/command-handlers/member-request.ts", // Request and first-idle reminder delivery.
	"pi/command-handlers/interrupt.ts", // Interrupt recovery and correlated response resume.
	"pi/inbox-bridge-runtime.ts", // Inbox handoff.
	"extension.ts", // Presence and startup/control responses.
];

async function source(relativePath: string): Promise<string> {
	return readFile(path.join(sourceRoot, relativePath), "utf8");
}

test("all Pi sendMessage calls are adapter composition points", async () => {
	const files = await Promise.all(productionFiles.map(async (file) => [file, await source(file)] as const));
	const directCalls = files.flatMap(([file, content]) =>
		[...content.matchAll(/\bpi\.sendMessage\s*\(/g)].map((match) => ({
			file,
			line: content.slice(0, match.index).split("\n").length,
			context: content.slice(Math.max(0, (match.index ?? 0) - 80), (match.index ?? 0) + 80),
		})),
	);

	assert.equal(directCalls.length, 3, "new direct Pi delivery calls require an explicit gate review");
	for (const call of directCalls) {
		assert.match(call.context, /createModelDeliveryAdapter/);
	}
});

test("model-bound surfaces depend on the gate adapter", async () => {
	const contents = await Promise.all(requiredModelSurfaces.map(source));
	for (const [index, content] of contents.entries()) {
		assert.match(content, /modelDelivery\s*\?*\.\s*(?:send|sendDurably|sendAndWait)/, requiredModelSurfaces[index]);
	}
});
