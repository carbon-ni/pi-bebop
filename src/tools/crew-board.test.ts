import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatCrewBoardDecision,
	normalizeCrewBoardErrorCode,
	registerLeaveCrewPostTool,
	registerReadCrewBoardTool,
	toCrewBoardDecisionView,
} from "./crew-board.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import { parseCrewManifest } from "../domain/index.ts";
import type { Membership } from "../infra/membership-runtime.ts";
import type { BoardReadResult, CrewPost } from "../domain/index.ts";

const manifestPath = "/project/.pi/bebop/crew.json";
const manifest = parseCrewManifest(
	{ version: 1, members: [{ name: "Mary", role: "po", socket: "sockets/mary.sock" }] },
	manifestPath,
);
const membership: Membership = {
	manifestPath,
	socketPath: manifest.members[0]!.socketPath,
	globalSocketPath: "/tmp/g.sock",
	member: manifest.members[0]!,
	manifest,
};
const state = { membershipRuntime: { getMembership: () => membership } } as never as SocketState;
const empty = {
	version: 1 as const,
	posts: [],
	nextCursor: null,
	hasMore: false,
	corruptCount: 0,
	quarantinedThisRead: 0,
	corruptCountTruncated: false,
};
function setup(register: (pi: ExtensionAPI, state: SocketState, deps: never) => void, deps: unknown) {
	let tool: any;
	const pi = {
		registerTool(value: unknown) {
			tool = value;
		},
	} as unknown as ExtensionAPI;
	register(pi, state, deps as never);
	return tool;
}

test("Crew Board tool schemas are closed and use public post_id links", () => {
	const deps = {
		isProjectTrusted: () => true,
		openStore: async () => ({ read: async () => empty, append: async () => ({}) }),
	};
	const append = setup(registerLeaveCrewPostTool, deps);
	const read = setup(registerReadCrewBoardTool, deps);
	assert.equal(
		Value.Check(append.parameters, {
			message: "hello",
			kind: "tip",
			link: { relation: "disputes", post_id: "post-" + "a".repeat(64) },
		}),
		true,
	);
	assert.equal(Value.Check(append.parameters, { message: "hello", author: "spoof" }), false);
	assert.equal(Value.Check(read.parameters, { limit: 20, kinds: ["tip"] }), true);
	assert.equal(Value.Check(read.parameters, { workflow: "x" }), false);
});

function readTool(result: BoardReadResult): any {
	return setup(registerReadCrewBoardTool, {
		isProjectTrusted: () => true,
		openStore: async () => ({ append: async () => ({}), read: async () => result }),
	});
}

function post(overrides: Partial<CrewPost> = {}): CrewPost {
	return {
		version: 1,
		id: "post-" + "a".repeat(64),
		sequence: 1,
		createdAt: 123,
		author: { name: "Dave", role: "dev" },
		kind: "tip",
		message: "TDD evidence discipline ...",
		references: [],
		link: null,
		redactions: [],
		semanticFingerprint: "b".repeat(64),
		...overrides,
	};
}

test("read_crew_board renders a compact empty and one-Post decision view", async () => {
	const emptyResult = await readTool(empty).execute("r", {});
	assert.equal(emptyResult.content[0].text, "Crew Board is empty.");
	assert.deepEqual(emptyResult.details, { posts: [] });

	const one = await readTool({ ...empty, posts: [post()] }).execute("r", {});
	assert.equal(one.content[0].text, "#1 [tip] Dave (dev)\nTDD evidence discipline ...");
	assert.deepEqual(one.details, {
		posts: [
			{ sequence: 1, kind: "tip", author: { name: "Dave", role: "dev" }, message: "TDD evidence discipline ..." },
		],
	});
	for (const forbidden of ["version", "createdAt", "semanticFingerprint", "redactions", "nextCursor", "hasMore"])
		assert.equal(JSON.stringify(one).includes(forbidden), false, forbidden);
});

test("read_crew_board adds only actionable references, links, continuation, and warnings", async () => {
	const linked = post({
		references: ["UL.md"],
		link: { relation: "disputes", postId: "post-" + "c".repeat(64) },
	});
	const result = {
		...empty,
		posts: [linked, post({ sequence: 2, message: "Second" })],
		nextCursor: "cursor-token",
		hasMore: true,
		corruptCount: 2,
		quarantinedThisRead: 1,
		corruptCountTruncated: true,
	};
	const output = await readTool(result).execute("r", {});
	assert.equal(
		output.content[0].text,
		"#1 [tip] Dave (dev)\nTDD evidence discipline ...\nReferences: UL.md\nLink: disputes post-" +
			"c".repeat(64) +
			"\n\n#2 [tip] Dave (dev)\nSecond\n\nMore: cursor-token\nWarning: 2 corrupt Posts; 1 Post quarantined during this read; corrupt Post count truncated",
	);
	assert.deepEqual(output.details, {
		posts: [
			{
				sequence: 1,
				kind: "tip",
				author: { name: "Dave", role: "dev" },
				message: "TDD evidence discipline ...",
				references: ["UL.md"],
				link: { relation: "disputes", post_id: "post-" + "c".repeat(64) },
			},
			{ sequence: 2, kind: "tip", author: { name: "Dave", role: "dev" }, message: "Second" },
		],
		nextCursor: "cursor-token",
		hasMore: true,
		warnings: ["2 corrupt Posts", "1 Post quarantined during this read", "corrupt Post count truncated"],
	});
	assert.equal(JSON.stringify(output.details).includes("createdAt"), false);
	assert.deepEqual(toCrewBoardDecisionView(empty), { posts: [] });
	assert.equal(formatCrewBoardDecision(empty), "Crew Board is empty.");
});

test("append tool adapts link and returns persisted-only acknowledgement", async () => {
	let input: any;
	const deps = {
		isProjectTrusted: () => true,
		openStore: async () => ({
			append: async (value: any) => {
				input = value;
				return {
					version: 1 as const,
					post: { id: "post-1", sequence: 2, createdAt: 4 },
					alreadyPersisted: true,
				};
			},
			read: async () => empty,
		}),
	};
	const result = await setup(registerLeaveCrewPostTool, deps).execute("tool-1", {
		message: "hello",
		link: { relation: "disputes", post_id: "post-" + "a".repeat(64) },
	});
	assert.deepEqual(input.author, { name: "Mary", role: "po" });
	assert.deepEqual(input.link, { relation: "disputes", postId: "post-" + "a".repeat(64) });
	assert.equal(result.details.persisted, true);
	assert.equal(result.details.alreadyPersisted, true);
	assert.match(result.content[0].text, /persisted/);
	assert.doesNotMatch(result.content[0].text, /deliver|notify|read/);
});

test("Board mapper preserves known store outcomes and rejects raw codes", () => {
	for (const code of ["untrusted-path", "invalid-read", "capacity-exceeded", "lock-conflict", "write-failed"])
		assert.equal(normalizeCrewBoardErrorCode(code), code);
	assert.equal(normalizeCrewBoardErrorCode("password-secret"), "board-failed");
});

test("registered Board tools sanitize all known and unknown store failures", async () => {
	for (const code of [
		"untrusted-path",
		"invalid-member",
		"invalid-append",
		"invalid-read",
		"invalid-cursor",
		"cursor-filter-mismatch",
		"capacity-exceeded",
		"directory-capacity-exceeded",
		"lock-conflict",
		"read-failed",
		"write-failed",
		"quarantine-failed",
		"idempotency-conflict",
		"link-target-invalid",
		"password-secret",
	]) {
		const thrown = Object.assign(new Error("raw /tmp/private.sock"), { code });
		const tool = setup(registerReadCrewBoardTool, {
			isProjectTrusted: () => true,
			openStore: async () => ({
				read: async () => {
					throw thrown;
				},
				append: async () => ({}),
			}),
		});
		const result = await tool.execute("r", {});
		assert.equal(result.isError, true);
		assert.equal(result.content[0].text, result.details.actionableError.message);
		assert.equal(JSON.stringify(result.details).includes("private.sock"), false);
		assert.match(result.content[0].text, /crew_board/);
		assert.equal(result.details.error, code === "password-secret" ? "board-failed" : code);
	}
});

test("read tool returns shared result and Membership loss rejects", async () => {
	let reads = 0;
	const current: { value: Membership | null } = { value: membership };
	const dynamic = { membershipRuntime: { getMembership: () => current.value } } as never as SocketState;
	const deps = {
		isProjectTrusted: () => true,
		openStore: async () => ({
			append: async () => ({}),
			read: async () => {
				reads += 1;
				return empty;
			},
		}),
	};
	const tool = (() => {
		let registered: any;
		const pi = {
			registerTool: (value: unknown) => {
				registered = value;
			},
		} as unknown as ExtensionAPI;
		registerReadCrewBoardTool(pi, dynamic, deps);
		return registered;
	})();
	assert.deepEqual((await tool.execute("r", {})).details, { posts: [] });
	current.value = null;
	const rejected = await tool.execute("r", {});
	assert.equal(rejected.isError, true);
	assert.equal(rejected.details.error, "stale-membership");
	assert.equal(rejected.details.actionableError.code, rejected.details.error);
	assert.equal(rejected.content[0].text, rejected.details.actionableError.message);
	assert.doesNotMatch(JSON.stringify(rejected.details), /private\.sock|Error:|stack/i);
	assert.equal(reads, 1);
});
