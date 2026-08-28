import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
	parseSessionListCommand,
	runSessionListCommand,
	sessionListHelp,
	type SessionListDependencies,
	type SessionListEntry,
} from "./session-list.ts";
import { UsageError } from "../arguments.ts";
import { writeOutcome, type CliOutcome } from "../output.ts";
import type { CliContext } from "../context.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

interface FakeStore {
	entries: string[];
	aliases: Record<string, string | null>;
	probeAlive: (socketPath: string) => boolean;
	statusOf: (socketPath: string) => "joined" | "online" | "stopped" | null;
}

function deps(store: FakeStore): SessionListDependencies {
	return {
		controlDir: () => "/bebop",
		readDir: async () => store.entries,
		readAliasTarget: async (aliasPath) => store.aliases[aliasPath] ?? null,
		probe: async (socketPath) => store.probeAlive(socketPath),
		queryStatus: async (socketPath) => store.statusOf(socketPath),
	};
}

function render(outcome: CliOutcome): { exit: number; text: string } {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const exit = writeOutcome(output, outcome);
	return { exit, text };
}

const LIVE: FakeStore = {
	entries: ["a-1.sock", "a-2.sock", "my-helper.alias", "../escape.alias", "broken.alias", "unsafe/../x.alias"],
	aliases: {
		"/bebop/my-helper.alias": "./a-1.sock",
		"/bebop/broken.alias": "./missing.sock",
	},
	probeAlive: (p) => p.endsWith("a-1.sock") || p.endsWith("a-2.sock"),
	statusOf: (p) => (p.endsWith("a-1.sock") ? "joined" : p.endsWith("a-2.sock") ? "online" : null),
};

// --- parse ---

test("session list parse: default text, optional --format, --help short-circuit", () => {
	assert.deepEqual(parseSessionListCommand([]), { command: "session-list", format: "text" });
	assert.deepEqual(parseSessionListCommand(["--format", "json"]), { command: "session-list", format: "json" });
	assert.equal(parseSessionListCommand(["--help"]).help, true);
	assert.throws(() => parseSessionListCommand(["--format", "toon", "--format", "json"]), /Duplicate flag: --format/);
	assert.throws(() => parseSessionListCommand(["--bogus"]), UsageError);
	assert.throws(() => parseSessionListCommand(["--format", "xml"]), /Invalid --format/);
});

// --- run ---

test("session list run: live joined/unjoined sessions with safe aliases, exit 0", async () => {
	const outcome = await runSessionListCommand({ command: "session-list", format: "json" }, context(), deps(LIVE));
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "listed");
	const data = outcome.result.data as { sessions: SessionListEntry[]; total: number; omitted: number };
	assert.equal(data.total, 2);
	assert.equal(data.omitted, 0);
	const byId = new Map(data.sessions.map((entry) => [entry.sessionId, entry]));
	assert.equal(byId.get("a-1")?.membership, "joined");
	assert.deepEqual(byId.get("a-1")?.aliases, ["my-helper"]);
	assert.equal(byId.get("a-2")?.membership, "unjoined");
	assert.deepEqual(byId.get("a-2")?.aliases, []);
	assert.equal(render(outcome).exit, 0);
});

test("session list run: ordering by primary alias then session id is deterministic", async () => {
	const store: FakeStore = {
		entries: ["b-1.sock", "a-1.sock", "z-alias.alias", "a-alias.alias"],
		aliases: { "/bebop/z-alias.alias": "./b-1.sock", "/bebop/a-alias.alias": "./a-1.sock" },
		probeAlive: () => true,
		statusOf: () => "online",
	};
	const outcome = await runSessionListCommand({ command: "session-list", format: "json" }, context(), deps(store));
	if (outcome.kind !== "result") throw new Error("expected result");
	const sessions = (outcome.result.data as { sessions: SessionListEntry[] }).sessions;
	assert.deepEqual(
		sessions.map((entry) => entry.sessionId),
		["a-1", "b-1"],
	);
});

test("session list run: non-live sockets are skipped, live but unqueryable is unknown", async () => {
	const store: FakeStore = {
		entries: ["dead.sock", "live-unknown.sock"],
		probeAlive: (p) => p.endsWith("live-unknown.sock"),
		statusOf: () => null,
		aliases: {},
	};
	const outcome = await runSessionListCommand({ command: "session-list", format: "json" }, context(), deps(store));
	if (outcome.kind !== "result") throw new Error("expected result");
	const sessions = (outcome.result.data as { sessions: SessionListEntry[] }).sessions;
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]?.sessionId, "live-unknown");
	assert.equal(sessions[0]?.membership, "unknown");
});

test("session list run: bound 256 filesystem entries and 100 output sessions", async () => {
	const entries = Array.from({ length: 280 }, (_, index) => `s-${index}.sock`);
	const aliasEntries = Array.from({ length: 12 }, (_, index) => `a-${index}.alias`);
	const store: FakeStore = {
		entries: [...aliasEntries, ...entries],
		aliases: Object.fromEntries(aliasEntries.map((name, index) => [`/bebop/${name}`, "./s-0.sock"])),
		probeAlive: () => true,
		statusOf: () => "online",
	};
	const outcome = await runSessionListCommand({ command: "session-list", format: "json" }, context(), deps(store));
	if (outcome.kind !== "result") throw new Error("expected result");
	const data = outcome.result.data as { sessions: SessionListEntry[]; total: number; omitted: number };
	// 292 entries − 256 scanned = 36 omitted by scan bound; 244 scanned sockets reach the output cap of 100 → 144 more omitted.
	assert.equal(data.sessions.length, 100);
	assert.equal(data.omitted, 36 + 144);
});

test("session list run: aliases capped at 8 per session", async () => {
	const aliasEntries = Array.from({ length: 12 }, (_, index) => `a-${index}.alias`);
	const store: FakeStore = {
		entries: ["s-0.sock", ...aliasEntries],
		aliases: Object.fromEntries(aliasEntries.map((name) => [`/bebop/${name}`, "./s-0.sock"])),
		probeAlive: () => true,
		statusOf: () => "online",
	};
	const outcome = await runSessionListCommand({ command: "session-list", format: "json" }, context(), deps(store));
	if (outcome.kind !== "result") throw new Error("expected result");
	const sessions = (outcome.result.data as { sessions: SessionListEntry[] }).sessions;
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]?.aliases.length, 8);
});

test("session list run: empty store returns empty state with copyable next step, exit 0", async () => {
	const store: FakeStore = { entries: ["dead.sock"], aliases: {}, probeAlive: () => false, statusOf: () => null };
	const outcome = await runSessionListCommand({ command: "session-list", format: "json" }, context(), deps(store));
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "empty");
	const data = outcome.result.data as { status: string; next: string };
	assert.equal(data.status, "empty");
	assert.match(data.next, /pi-bebop session list/);
	assert.equal(render(outcome).exit, 0);
});

test("session list run: unreadable control store is control-store-unavailable, exit 1", async () => {
	const store: FakeStore = { entries: [], aliases: {}, probeAlive: () => false, statusOf: () => null };
	const broken = deps(store);
	broken.readDir = async () => {
		throw new Error("read failed at /var/folders/qa/private.sock");
	};
	const outcome = await runSessionListCommand({ command: "session-list", format: "json" }, context(), broken);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error?.code, "control-store-unavailable");
	assert.equal(render(outcome).text.includes("private.sock"), false);
	assert.equal(render(outcome).text.includes("var/folders"), false);
	assert.equal(render(outcome).exit, 1);
});

test("session list run: output never leaks socket paths, focus, or messages", async () => {
	const outcome = await runSessionListCommand({ command: "session-list", format: "toon" }, context(), deps(LIVE));
	const text = render(outcome).text;
	assert.doesNotMatch(text, /\.sock|\.alias|focus|Focus|message|instructions/i);
});

test("session list run: --help returns deterministic help text", async () => {
	const outcome = await runSessionListCommand(
		{ command: "session-list", format: "toon", help: true },
		context(),
		deps(LIVE),
	);
	assert.equal(outcome.kind, "help");
	if (outcome.kind !== "help") return;
	assert.equal(outcome.text, sessionListHelp());
	assert.equal(render(outcome).exit, 0);
});
