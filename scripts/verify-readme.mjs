#!/usr/bin/env node
/**
 * TASK-0078 README contract checker.
 *
 * Verifies README.md against the lean-product-entrypoint contract: size
 * baseline, heading depth, hero illustration+tagline, one copyable happy path,
 * resolving relative links, UL canonical
 * capability terms, explicit boundaries, no internal task IDs, truthful
 * npm-publication claims (checked against the registry), and that every
 * `pi-bebop` command snippet resolves against the packaged CLI help.
 *
 * Exits 0 when every check passes; prints one line per failed check otherwise.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, extname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");
const failures = [];

function check(name, ok, detail = "") {
	if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

function words(text) {
	const stripped = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.trim();
	return stripped.split(/\s+/).filter(Boolean).length;
}

const readme = readFileSync(readmePath, "utf8");
const lines = readme.split("\n");

// 1. Size baseline (at most 140 lines and 800 words, excluding image URL/code).
check("size-lines", lines.length <= 140, `${lines.length} lines (max 140)`);
const wordCount = words(readme);
check("size-words", wordCount <= 800, `${wordCount} words (max 800)`);

// 2. Heading depth: no section deeper than `###`.
const deepHeadings = lines.filter((line) => /^#{4,}\s/.test(line));
check("heading-depth", deepHeadings.length === 0, deepHeadings[0] ?? "");

// 3. Hero: illustration + tagline visible at the top (first 14 lines).
const head = lines.slice(0, 14).join("\n");
check("hero-illustration", /<img[^>]*alt="bebop"/i.test(head), "illustration missing in first 14 lines");
check("hero-tagline", /small dysfunctional but effective crew/.test(head), "tagline missing in first 14 lines");

// 4. One copyable happy path: crew init, two roles, roster command in one block.
const bashBlocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const happyPath = bashBlocks.find(
	(block) =>
		/crew init/.test(block) &&
		/--crew-role lead/.test(block) &&
		/--crew-role developer/.test(block) &&
		/crew members/.test(block),
);
check("happy-path", Boolean(happyPath), "no single block with crew init + --crew-role lead/developer + crew members");

// 5. Relative links resolve with correct filename/case.
const linkTargets = [...readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
	.map((m) => m[1])
	.filter((t) => !/^https?:/.test(t) && !t.startsWith("#") && !t.startsWith("mailto:"));
for (const target of linkTargets) {
	const clean = target.split("#")[0];
	if (!clean) continue;
	const resolved = resolve(dirname(readmePath), clean);
	if (!existsSync(resolved)) check("link-resolves", false, `${target} (${relative(root, resolved)})`);
}
check("link-resolves", failures.filter((f) => f.startsWith("link-resolves")).length === 0);

// 6. UL canonical capability terms, differentiated, without full schemas.
const tools = [
	"send_member_request",
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"interrupt_member",
	"broadcast_to_crew",
];
check(
	"ul-tools",
	tools.every((t) => readme.includes(t)),
	tools.filter((t) => !readme.includes(t)).join(","),
);
check("no-schemas", !/send_follow_up\(\{|broadcast_to_crew\(\{/.test(readme), "full tool schemas must not appear");

// 8. Boundaries explicit and central (not repeated per feature).
check(
	"transport-boundary",
	(readme.match(/transport,\s*not\s*a?\s*workflow|transport,\s*not\s*workflow/i) ?? []).length === 1,
	"exactly one transport-not-workflow boundary",
);
check("roles-not-permissions", /roles?\s+(describe|are)\s+responsibility,\s*not\s*permissions/i.test(readme));
check("no-repeated-never", (readme.match(/never\s+means\s+completed|never.*completed.*paragraph/i) ?? []).length <= 1);

// 9. No internal task IDs in reader-facing prose.
const taskIds = readme.match(/TASK-\d{4}/g) ?? [];
check("no-task-ids", taskIds.length === 0, taskIds.join(","));

// 10. npm publication claims truthful: claim only when `npm view` succeeds.
function npmPublished(pkg) {
	try {
		execFileSync("npm", ["view", pkg, "version", "--json"], { timeout: 8_000, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}
const piPublished = npmPublished("pi-bebop");
const cliPublished = npmPublished("pi-bebop-cli");
const claimsPublication =
	/is\s+published\s+to\s+npm|were\s+published|published\s+on\s+npm|registry\.npmjs\.org|legacy\s+package\s+name/.test(
		readme,
	);
check(
	"npm-truthful",
	!claimsPublication || piPublished || cliPublished,
	piPublished ? "pi-bebop published" : "pi-bebop NOT on npm",
);
check("npm-neither-when-unpublished", !(claimsPublication && !piPublished && !cliPublished));

// 11. Command snippets resolve against the packaged CLI help (requires dist build).
const cliMain = join(root, "dist", "cli", "main.js");
if (existsSync(cliMain)) {
	const helpLines = execFileSync(process.execPath, [cliMain, "--help"], { encoding: "utf8" });
	const commandNames = [...helpLines.matchAll(/^\s{2}([a-z][a-z -]+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
	const leafTokens = commandNames.map((c) => c.split(/\s+/).slice(0, 2).join(" "));
	for (const block of bashBlocks) {
		for (const line of block.split("\n")) {
			const match = line.match(/^\s*pi-bebop\s+([a-z][a-z-]+(?:\s+[a-z-]+)?)/);
			if (!match) continue;
			const tokens = match[1];
			if (!leafTokens.includes(tokens)) {
				check("command-known", false, `${tokens} not in CLI help`);
				continue;
			}
			try {
				execFileSync(process.execPath, [cliMain, ...tokens.split(/\s+/), "--help"], { stdio: "pipe" });
			} catch {
				check("command-help", false, `pi-bebop ${tokens} --help failed`);
			}
		}
	}
}

if (failures.length > 0) {
	console.error(`README contract failures (${failures.length}):`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(
	`README contract OK: ${lines.length} lines, ${wordCount} words, ${linkTargets.length} relative links, ${bashBlocks.length} bash blocks.`,
);
