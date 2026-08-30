import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createModelDeliveryAdapter } from "../src/pi/compaction-delivery.ts";
import { openTrustedCompactionDeliveryJournal } from "../src/infra/compaction-delivery-journal.ts";

const mode = process.argv[2];
const root = process.env.COMPACTION_CRASH_ROOT;
if (!mode || !root) throw new Error("mode and COMPACTION_CRASH_ROOT are required");

const manifestPath = path.join(root, ".pi", "bebop", "crew.json");
await fs.mkdir(path.dirname(manifestPath), { recursive: true });
await fs.writeFile(manifestPath, "{}\n");
const journal = await openTrustedCompactionDeliveryJournal({
	manifestPath,
	projectRoot: root,
	isProjectTrusted: () => true,
	memberName: "Dave",
});
const envelope = {
	id: "delivery-crash-1",
	bytes: 64,
	message: { customType: "crew", content: "crash probe" },
	delivery: { triggerTurn: true },
	metadata: { deliveryId: "delivery-crash-1" },
};

const linger = (): Promise<never> => new Promise(() => undefined);
const sent: unknown[] = [];
const adapter = createModelDeliveryAdapter((message) => {
	sent.push(message);
	console.log(`sent:${JSON.stringify(message)}`);
});
const evidenced = mode === "recover-evidenced";
await adapter.configureJournal(
	journal,
	() => evidenced,
	() => mode !== "recover-replay",
);

if (mode === "crash-before-append") {
	console.log("ready-before-append");
	await linger();
}
if (mode === "crash-after-append") {
	await journal.append(envelope, 1);
	console.log("acknowledged-after-append");
	await linger();
}
if (mode === "crash-after-handoff") {
	await journal.append(envelope, 1);
	await journal.markHandingOff(envelope.id);
	console.log("ready-after-handoff");
	await linger();
}
if (mode === "recover-pending") {
	await new Promise((resolve) => setTimeout(resolve, 50));
	console.log(`recovered-pending:${sent.length}`);
}
if (mode === "recover-replay") {
	await new Promise((resolve) => setTimeout(resolve, 50));
	console.log(`recovered-replay:${sent.length}`);
}
if (mode === "recover-evidenced") {
	await new Promise((resolve) => setTimeout(resolve, 50));
	console.log(`recovered-evidenced:${sent.length}`);
}
if (mode === "recover-blocked") {
	await new Promise((resolve) => setTimeout(resolve, 50));
	console.log(`recovered-blocked:${sent.length}`);
}

const records = await journal.listPending();
console.log(
	`records:${JSON.stringify(records.map((record) => ({ id: record.id, state: record.state, replayAttempts: record.replayAttempts })))}`,
);
