import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SKILL_PATH = new URL("../../skills/pi-intray/SKILL.md", import.meta.url);

test("intray skill describes member and explicit session targeting", async () => {
	const skill = await readFile(SKILL_PATH, "utf8");
	assert.match(skill, /send_to_member/);
	assert.match(skill, /send_to_session/);
	const removedTool = ["send", "to", "peer"].join("_");
	assert.doesNotMatch(skill, new RegExp(removedTool));
});
