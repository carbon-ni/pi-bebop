import test from "node:test";
import assert from "node:assert/strict";
import { parseCrewManifest } from "../domain/index.ts";
import type { Membership } from "../infra/membership-runtime.ts";
import { CrewBoardApplicationError, leaveCrewPost, readCrewBoard } from "./crew-board.ts";

const manifestPath = "/project/.pi/bebop/crew.json";
const manifest = parseCrewManifest(
	{
		version: 1,
		members: [
			{ name: "Mary", role: "po", socket: "sockets/mary.sock" },
			{ name: "Kelly", role: "qa", socket: "sockets/kelly.sock" },
		],
	},
	manifestPath,
);
const membership: Membership = {
	manifestPath,
	socketPath: manifest.members[0]!.socketPath,
	globalSocketPath: "/tmp/g.sock",
	member: manifest.members[0]!,
	manifest,
};
const emptyRead = {
	version: 1 as const,
	posts: [],
	nextCursor: null,
	hasMore: false,
	corruptCount: 0,
	quarantinedThisRead: 0,
	corruptCountTruncated: false,
};
function deps(store: unknown, trusted = true) {
	let opened = 0;
	return {
		opened: () => opened,
		dependencies: {
			isProjectTrusted: () => trusted,
			openStore: async () => {
				opened += 1;
				return store as never;
			},
		},
	};
}

test("Crew Board operations derive author from exact active Membership and open the store once", async () => {
	const calls: unknown[] = [];
	const { dependencies } = deps({
		append: async (input: unknown) => {
			calls.push(input);
			return { version: 1 as const, post: { id: "post-id" }, alreadyPersisted: false };
		},
		read: async () => emptyRead,
	});
	const result = await leaveCrewPost({ membership, operationId: "op-1", message: "hello", now: 10 }, dependencies);
	assert.equal(result.alreadyPersisted, false);
	assert.deepEqual((calls[0] as { author: unknown }).author, { name: "Mary", role: "po" });
});

test("unjoined, untrusted, stale, and unsupported Membership reject before store IO", async () => {
	let opened = 0;
	const dependencies = {
		isProjectTrusted: () => true,
		openStore: async () => {
			opened += 1;
			throw new Error("must not open");
		},
	};
	for (const request of [
		{ membership: null },
		{ membership: { ...membership, member: { ...membership.member, role: "wrong" } } },
	])
		await assert.rejects(() => readCrewBoard(request, dependencies), CrewBoardApplicationError);
	await assert.rejects(
		() => readCrewBoard({ membership }, { ...dependencies, isProjectTrusted: () => false }),
		/untrusted/,
	);
	await assert.rejects(
		() =>
			readCrewBoard(
				{ membership: { ...membership, manifestPath: "/project/.pi/other/crew.json" } },
				dependencies,
			),
		/supported/,
	);
	assert.equal(opened, 0);
});

test("store-boundary Membership recheck rejects a leave or switch before opening", async () => {
	let opened = 0;
	const dependencies = {
		isProjectTrusted: () => true,
		getCurrentMembership: () => null,
		openStore: async () => {
			opened += 1;
			throw new Error("must not open");
		},
	};
	await assert.rejects(
		() => readCrewBoard({ membership }, dependencies),
		(error: unknown) => {
			assert.equal((error as CrewBoardApplicationError).code, "stale-membership");
			return true;
		},
	);
	assert.equal(opened, 0);
});

test("invalid append and read input reject before store IO", async () => {
	const { opened, dependencies } = deps({
		append: async () => {
			throw new Error("must not");
		},
		read: async () => emptyRead,
	});
	await assert.rejects(
		() => leaveCrewPost({ membership, operationId: "op-1", message: "", now: 1 }, dependencies),
		/message/,
	);
	await assert.rejects(() => readCrewBoard({ membership, limit: 101 }, dependencies), /limit/);
	assert.equal(opened(), 0);
});

test("read is shared and has no delivery side effects", async () => {
	const { dependencies } = deps({
		append: async () => {
			throw new Error("no append");
		},
		read: async (options: unknown) => {
			assert.deepEqual(options, { limit: 20, kinds: [] });
			return emptyRead;
		},
	});
	assert.deepEqual(await readCrewBoard({ membership }, dependencies), emptyRead);
});
