import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
async function sourceFiles(dir) {
	const files = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(file);
	}
	return files;
}
const files = await sourceFiles(path.join(root, "src", "cli"));
const registry = await readFile(path.join(root, "src", "cli", "registry.ts"), "utf8");
const names = [...registry.matchAll(/\brun[A-Z]\w*Command\b/g)].map((match) => match[0]);
const uniqueNames = [...new Set(["runCli", ...names])];
const targets = [];
for (const name of uniqueNames) {
	const matches = [];
	for (const file of files) {
		if ((await readFile(file, "utf8")).match(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`)))
			matches.push(file);
	}
	if (matches.length !== 1)
		throw new Error(`${name} must resolve to exactly one CLI leaf function; found ${matches.length}`);
	targets.push([path.relative(root, matches[0]), name]);
}

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
	const complexity = 1 + (body.match(/\b(?:if|catch|for|while|case)\b|&&|\|\|/g) ?? []).length;
	console.log(`${name}: complexity=${complexity} (max 10)`);
	if (complexity > 10) failed = true;
}
if (failed) process.exitCode = 1;
