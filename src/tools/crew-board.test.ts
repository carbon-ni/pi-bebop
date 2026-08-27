import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLeaveCrewPostTool, registerReadCrewBoardTool } from "./crew-board.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import { parseCrewManifest } from "../domain/index.ts";
import type { Membership } from "../infra/membership-runtime.ts";

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
	assert.deepEqual((await tool.execute("r", {})).details, empty);
	current.value = null;
	const rejected = await tool.execute("r", {});
	assert.equal(rejected.isError, true);
	assert.equal(rejected.details.error, "not-joined");
	assert.equal(reads, 1);
});
