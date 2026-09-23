import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { renderCliResult, writeOutcome, type CliResult } from "./output.ts";

const content = "safe\u009d\u007f\u001b[31m\u0007";
const result: CliResult = {
	ok: true,
	target: "developer",
	status: "observed",
	response: content,
	data: { message: { role: "assistant", content, timestamp: 1 } },
};

test("CLI serialization escapes raw DEL and C1 controls without mutating JSON data", () => {
	const rendered = renderCliResult(result, "json", false);
	assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
	assert.deepEqual(JSON.parse(rendered), {
		...result,
		truncation: { truncated: false, originalChars: content.length, shownChars: content.length },
	});
});

test("CLI TOON serialization contains no raw terminal controls", () => {
	const rendered = renderCliResult(result, "toon", false);
	assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
});

test("writeOutcome hardens the final serialized output boundary", () => {
	const output = new PassThrough();
	let written = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => (written += chunk));
	assert.equal(writeOutcome(output, new PassThrough(), { kind: "result", result, format: "json", full: false }), 0);
	assert.doesNotMatch(written.slice(0, -1), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
});
