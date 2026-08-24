import { readFile } from "node:fs/promises";
import path from "node:path";

const targets = [
	["src/cli/run.ts", "runCli"],
	["src/cli/commands/member-status.ts", "runMemberStatusCommand"],
	["src/cli/commands/member-message.ts", "runMemberMessageCommand"],
	["src/cli/commands/member-focus.ts", "runMemberFocusCommand"],
	["src/cli/commands/member-idle-wait.ts", "runMemberIdleWaitCommand"],
	["src/cli/commands/member-interrupt.ts", "runMemberInterruptCommand"],
];

function bodyOf(source, name) {
	const match = source.match(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`));
	if (!match) throw new Error(`${name} was not found`);
	const open = source.indexOf("{", match.index + match[0].length);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(open, index + 1);
		}
	}
	throw new Error(`${name} has an unterminated body`);
}

let failed = false;
for (const [relative, name] of targets) {
	const body = bodyOf(await readFile(path.join(process.cwd(), relative), "utf8"), name);
	// This intentionally conservative metric mirrors cyclomatic contributors
	// used by the AST report: one base path plus control-flow/logical branches.
	const complexity = 1 + (body.match(/\b(?:if|catch|for|while|case)\b|&&|\|\||\?/g) ?? []).length;
	console.log(`${name}: complexity=${complexity} (max 10)`);
	if (complexity > 10) failed = true;
}
if (failed) process.exitCode = 1;
