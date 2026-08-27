import test from "node:test";
import assert from "node:assert/strict";
import { parseCrewBoardCommand } from "./crew-board-command.ts";

test("parses post flags without inferring kind from message prose", () => {
	assert.deepEqual(parseCrewBoardCommand("post", "tip this is a note"), {
		action: "post",
		message: "tip this is a note",
	});
	assert.deepEqual(
		parseCrewBoardCommand("post", "--kind tip --ref TASK-1 --ref docs/README.md --disputes post-abc hello world"),
		{
			action: "post",
			kind: "tip",
			references: ["TASK-1", "docs/README.md"],
			relation: "disputes",
			postId: "post-abc",
			message: "hello world",
		},
	);
});

test("rejects malformed post flags and duplicates before application", () => {
	for (const raw of [
		"",
		"--kind",
		"--kind nope hi",
		"--kind tip --kind note hi",
		"--ref",
		"--ref A --ref A hi",
		"--supersedes x --disputes y hi",
		"hello --kind tip",
	]) {
		assert.ok("error" in parseCrewBoardCommand("post", raw), raw);
	}
});

test("parses bounded board filters and rejects positional or duplicate arguments", () => {
	assert.deepEqual(parseCrewBoardCommand("board", "--kind note --kind tip --after opaque --limit 10"), {
		action: "board",
		kinds: ["note", "tip"],
		after: "opaque",
		limit: 10,
	});
	for (const raw of ["hello", "--kind note --kind note", "--limit", "--limit x", "--unknown x"]) {
		assert.ok("error" in parseCrewBoardCommand("board", raw), raw);
	}
});
