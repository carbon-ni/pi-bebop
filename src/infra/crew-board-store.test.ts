import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openTrustedCrewBoardStore, CREW_BOARD_POSTS_DIRNAME } from "./crew-board-store.ts";
import { canonicalCrewPostBytes } from "../domain/index.ts";

const member = (name: string, role: string) => ({
	name,
	role,
	socketPath: `/project/.pi/bebop/sockets/${name.toLowerCase()}.sock`,
});
async function fixture(layoutName = "bebop") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-board-"));
	const layout = path.join(root, ".pi", layoutName);
	await fs.mkdir(layout, { recursive: true });
	await fs.writeFile(path.join(layout, "crew.json"), "{}", "utf8");
	const current = member("Mary", "po");
	const options = {
		projectRoot: root,
		manifestPath: path.join(layout, "crew.json"),
		isProjectTrusted: () => true,
		member: current,
		members: [current, member("Dave", "dev")],
	};
	return { root, options };
}
function appendInput(operationId: string, message = operationId) {
	return { operationId, author: { name: "Mary", role: "po" }, message };
}

test("missing read creates nothing; append publishes canonical post and deterministic newest read", async () => {
	const h = await fixture();
	const store = await openTrustedCrewBoardStore(h.options);
	assert.deepEqual(await store.read(), {
		version: 1,
		posts: [],
		nextCursor: null,
		hasMore: false,
		corruptCount: 0,
		quarantinedThisRead: 0,
		corruptCountTruncated: false,
	});
	assert.equal(await fs.stat(path.join(h.root, ".pi", "bebop", "board")).catch(() => null), null);
	const first = await store.append(appendInput("one"), 100);
	assert.equal(first.alreadyPersisted, false);
	assert.equal((await store.read()).posts[0]?.id, first.post.id);
	assert.equal(
		await fs.readFile(
			path.join(h.root, ".pi", "bebop", "board", CREW_BOARD_POSTS_DIRNAME, `${first.post.id}.json`),
			"utf8",
		),
		canonicalCrewPostBytes(first.post),
	);
	await fs.rm(h.root, { recursive: true, force: true });
});

test("replay is unchanged, conflicting operation is rejected, and concurrent appends are lossless", async () => {
	const h = await fixture();
	const store = await openTrustedCrewBoardStore(h.options);
	const same = appendInput("same", "hello");
	const first = await store.append(same, 100);
	const replay = await store.append(same, 999);
	assert.equal(replay.alreadyPersisted, true);
	assert.equal(replay.post.sequence, first.post.sequence);
	await assert.rejects(
		() => store.append(appendInput("same", "different"), 100),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "idempotency-conflict",
	);
	await Promise.all(["a", "b", "c"].map((id) => store.append(appendInput(id), 100)));
	const result = await store.read({ limit: 100 });
	assert.equal(result.posts.length, 4);
	assert.deepEqual(
		result.posts.map((post) => post.sequence).sort((a, b) => a - b),
		[1, 2, 3, 4],
	);
	await fs.rm(h.root, { recursive: true, force: true });
});

test("links enforce prior target and same-author supersedes versus disputes", async () => {
	const h = await fixture();
	const store = await openTrustedCrewBoardStore(h.options);
	const first = await store.append(appendInput("one"), 1);
	const second = await store.append(
		{ ...appendInput("two"), link: { relation: "supersedes", postId: first.post.id } },
		2,
	);
	assert.equal(second.post.link?.relation, "supersedes");
	await assert.rejects(
		() => store.append({ ...appendInput("three"), link: { relation: "disputes", postId: first.post.id } }, 3),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "link-target-invalid",
	);
	await fs.rm(h.root, { recursive: true, force: true });
});

test("pagination cursor keeps the healthy scan boundary across filters", async () => {
	const h = await fixture();
	const store = await openTrustedCrewBoardStore(h.options);
	await store.append({ ...appendInput("one"), kind: "tip" }, 1);
	await store.append({ ...appendInput("two"), kind: "warning" }, 2);
	await store.append({ ...appendInput("three"), kind: "tip" }, 3);
	const first = await store.read({ limit: 1, kinds: ["tip"] });
	assert.equal(first.posts.length, 1);
	assert.ok(first.nextCursor);
	const second = await store.read({ limit: 1, kinds: ["tip"], after: first.nextCursor! });
	assert.equal(second.posts.length, 1);
	assert.equal(second.posts[0]?.kind, "tip");
	assert.equal(second.hasMore, false);
	await fs.rm(h.root, { recursive: true, force: true });
});

test("malformed post is quarantined while healthy posts remain readable", async () => {
	const h = await fixture();
	const store = await openTrustedCrewBoardStore(h.options);
	const healthy = await store.append(appendInput("healthy"), 1);
	const postsDir = path.join(h.root, ".pi", "bebop", "board", CREW_BOARD_POSTS_DIRNAME);
	await fs.writeFile(path.join(postsDir, "post-" + "f".repeat(64) + ".json"), "{not-json", "utf8");
	const result = await store.read();
	assert.equal(result.posts.length, 1);
	assert.equal(result.posts[0]?.id, healthy.post.id);
	assert.equal(result.quarantinedThisRead, 1);
	assert.equal((await fs.readdir(path.join(h.root, ".pi", "bebop", "board", "quarantine"))).length, 1);
	await fs.rm(h.root, { recursive: true, force: true });
});

test("trust and compatibility layouts are isolated", async () => {
	const bebop = await fixture("bebop");
	const crew = await fixture("crew");
	const first = await (await openTrustedCrewBoardStore(bebop.options)).append(appendInput("b"), 1);
	const second = await openTrustedCrewBoardStore(crew.options);
	assert.equal((await second.read()).posts.length, 0);
	await assert.rejects(
		() => openTrustedCrewBoardStore({ ...bebop.options, isProjectTrusted: () => false }),
		/untrusted/,
	);
	assert.notEqual(first.post.id, undefined);
	await fs.rm(bebop.root, { recursive: true, force: true });
	await fs.rm(crew.root, { recursive: true, force: true });
});
