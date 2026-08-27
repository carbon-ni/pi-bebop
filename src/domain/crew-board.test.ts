import { test } from "node:test";
import assert from "node:assert/strict";
import {
	canonicalCrewPostBytes,
	createBoardPost,
	decodeBoardCursor,
	encodeBoardCursor,
	isCrewPost,
	MAX_BOARD_MESSAGE_BYTES,
	boardScopeForLayout,
} from "./index.ts";

const author = { name: "Mary", role: "po" };
const scope = boardScopeForLayout("/repo/.pi/bebop");
function input(overrides: Record<string, unknown> = {}) {
	return { operationId: "op-1", author, message: "hello", ...overrides } as Parameters<typeof createBoardPost>[0];
}

test("creates canonical immutable post with deterministic id/fingerprint and default kind", () => {
	const post = createBoardPost(input({ references: ["docs/README.md", "TASK-0107"] }), 1, 100, scope);
	assert.equal(post.kind, "note");
	assert.equal(post.id, createBoardPost(input({ references: ["TASK-0107", "docs/README.md"] }), 99, 900, scope).id);
	assert.equal(canonicalCrewPostBytes(post).endsWith("\n"), true);
	assert.equal(isCrewPost(JSON.parse(canonicalCrewPostBytes(post))), true);
});

test("redacts deterministic message credentials and rejects sensitive references", () => {
	const post = createBoardPost(input({ message: "Authorization: Bearer abcdefgh" }), 1, 1, scope);
	assert.equal(post.message, "Authorization: Bearer [REDACTED:credential]");
	assert.deepEqual(post.redactions, ["credential"]);
	assert.throws(() => createBoardPost(input({ references: ["token:abcdef"] }), 1, 1, scope), /sensitive/);
});

test("rejects unsafe links, duplicate references, invalid operation, and oversized message", () => {
	assert.throws(() => createBoardPost(input({ link: { relation: "disputes", postId: "x" } }), 1, 1, scope), /link/);
	assert.throws(() => createBoardPost(input({ references: ["TASK-1", "TASK-1"] }), 1, 1, scope), /unique/);
	assert.throws(() => createBoardPost(input({ operationId: "../bad" }), 1, 1, scope), /operation/);
	assert.throws(
		() => createBoardPost(input({ message: "x".repeat(MAX_BOARD_MESSAGE_BYTES + 1) }), 1, 1, scope),
		/message/,
	);
});

test("cursor is board/filter-bound and round-trips deterministically", () => {
	const cursor = encodeBoardCursor({
		board: scope,
		sequence: 4,
		id: `post-${"a".repeat(64)}`,
		kinds: ["warning", "tip"],
	});
	assert.deepEqual(decodeBoardCursor(cursor, scope, ["tip", "warning"]), {
		board: scope,
		sequence: 4,
		id: `post-${"a".repeat(64)}`,
		kinds: ["tip", "warning"],
	});
	assert.throws(() => decodeBoardCursor(cursor, "f".repeat(64), ["tip", "warning"]), /cursor/);
});
