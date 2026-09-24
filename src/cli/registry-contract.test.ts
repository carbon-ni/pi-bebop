import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { PassThrough } from "node:stream";
import { composeRegistry, createCliRegistry, type CliContext, type CliLeaf } from "./registry.ts";
import { writeOutcome } from "./support/output.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

const pingLeaf: CliLeaf = {
	id: "ping",
	names: ["ping"],
	build: () => new Command("ping").description("Respond to pings").argument("<target>"),
	read: (command) => ({ command: "ping", target: command.args[0] }),
	run: async (options) => ({
		kind: "result",
		result: {
			ok: true,
			target: String((options as { target?: string }).target ?? ""),
			status: "pong",
		},
		format: "toon",
		full: false,
	}),
};

const crewAuditLeaf: CliLeaf = {
	id: "crew-audit",
	names: ["crew", "audit"],
	build: () => new Command("audit").description("Audit crew state"),
	read: () => ({ command: "crew-audit" }),
	run: async () => ({ kind: "help", text: "crew audit ran" }),
};

/**
 * Adding a membership leaf is ONE registry contribution — append the leaf
 * module to the ordered list. The command tree derives from the leaves;
 * parser, root-tree, help, and dispatch are never edited per command.
 */
test("synthetic nested/top-level leaves work through the real tree and dispatch with one registry contribution each", async () => {
	const base = createCliRegistry();
	const registry = composeRegistry([...base.leaves, pingLeaf, crewAuditLeaf]);

	// Command-tree metadata derives from the registry: top-level leaf + nested leaf under the crew group.
	const root = registry.root();
	assert.ok(
		root.commands.some((command) => command.name() === "ping"),
		"top-level ping leaf present",
	);
	const crew = root.commands.find((command) => command.name() === "crew");
	assert.ok(crew, "crew group derived from registry");
	assert.ok(crew!.commands.some((command) => command.name() === "init"));
	assert.ok(crew!.commands.some((command) => command.name() === "roles"));
	assert.ok(crew!.commands.some((command) => command.name() === "audit"));

	// Dispatch derives from the registry and renders through the single output boundary.
	const outcome = await registry.leafById("ping").run({ command: "ping", target: "socket-1" }, context());
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	assert.equal(writeOutcome(output, new PassThrough(), outcome), 0);
	assert.match(text, /status: pong/);
	assert.match(text, /target: socket-1/);
});

test("composeRegistry yields deterministic ordered composition without shared mutable state", () => {
	const base = createCliRegistry();
	const first = composeRegistry([...base.leaves, pingLeaf, crewAuditLeaf]);
	const second = composeRegistry([...base.leaves, pingLeaf, crewAuditLeaf]);

	assert.deepEqual(
		first.leaves.map((leaf) => leaf.id),
		second.leaves.map((leaf) => leaf.id),
	);
	// Independent registries expose equivalent leaves.
	assert.equal(first.leafById("ping").id, second.leafById("ping").id);
});

test("createCliRegistry composes the ordered built-in leaves with no compatibility surfaces", () => {
	const registry = createCliRegistry();
	assert.deepEqual(
		registry.leaves.map((leaf) => leaf.id),
		[
			"contact",
			"ask",
			"crew-init",
			"crew-list",
			"session-capture",
			"session-add",
			"session-list",
			"session-show",
			"session-resolve",
			"session-resume",
			"crew-roles",
			"member-status",
			"member-last-message",
			"member-idle-wait",
			"session-live",
			"member-follow-up",
			"member-redirect",
			"member-request-send",
			"member-request-list",
			"member-request-wait",
			"member-request-respond",
			"member-interrupt",
			"member-inbox-send",
			"crew-broadcast",
			"guest-join",
			"guest-leave",
			"guest-send",
			"guest-broadcast",
		],
	);
	// No home, no top-level send, no crew-session rejection shim.
	const ids = new Set(registry.leaves.map((leaf) => leaf.id));
	assert.equal(ids.has("home"), false);
	assert.equal(ids.has("send"), false);
	assert.equal(ids.has("crew-session-rejected"), false);

	// Command-tree metadata: every canonical group and leaf exists.
	const root = registry.root();
	const member = root.commands.find((command) => command.name() === "member");
	assert.ok(member, "member group derived from registry");
	assert.ok(member!.commands.some((command) => command.name() === "status"));
	assert.ok(member!.commands.some((command) => command.name() === "last-message"));
	assert.ok(member!.commands.some((command) => command.name() === "follow-up"));
	assert.ok(member!.commands.some((command) => command.name() === "redirect"));
	const inbox = member!.commands.find((command) => command.name() === "inbox");
	assert.ok(inbox, "member inbox group derived from registry");
	assert.ok(inbox!.commands.some((command) => command.name() === "send"));
	const crew = root.commands.find((command) => command.name() === "crew");
	assert.ok(crew, "crew group derived from registry");
	assert.ok(crew!.commands.some((command) => command.name() === "init"));
	assert.ok(crew!.commands.some((command) => command.name() === "roles"));
	assert.ok(crew!.commands.some((command) => command.name() === "broadcast"));
	assert.ok(!crew!.commands.some((command) => command.name() === "session"));
	const session = root.commands.find((command) => command.name() === "session");
	assert.ok(session, "session group derived from registry");
	for (const name of ["capture", "add", "list", "show", "resolve", "resume", "live"]) {
		assert.ok(
			session!.commands.some((command) => command.name() === name),
			name,
		);
	}
	const guest = root.commands.find((command) => command.name() === "guest");
	assert.ok(guest, "guest group derived from registry");
	for (const name of ["join", "leave", "send", "broadcast"]) {
		assert.ok(
			guest!.commands.some((command) => command.name() === name),
			name,
		);
	}
});
