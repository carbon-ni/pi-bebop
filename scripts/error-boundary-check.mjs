import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = path.resolve(rootArg !== -1 ? args[rootArg + 1] : process.cwd());
const baselinePath = path.join(root, "error-boundary-baseline.json");
const mode = args.includes("--init-baseline") ? "init" : args.includes("--update-baseline") ? "update" : "check";

const scopes = [
	["src/cli", "cli-result"],
	["src/tools", "tool-result"],
	["src/pi/control-commands.ts", "pi-notify"],
	["src/pi/session-start.ts", "pi-notify"],
	["src/pi/startup-send.ts", "pi-notify"],
	["src/extension.ts", "pi-notify"],
];
const patterns = {
	"cli-result": /\bok\s*:\s*false\b|\bCliResult\s*<[^>]*>\s*\{|\b(?:errorResult|usageResult)\s*\(/,
	"tool-result": /\bisError\s*:\s*true\b/,
	"pi-notify": /\b(?:ui\.)?notify\s*\([^\n;]*["']error["']\)|\bconsole\.error\s*\(/,
};

async function filesFor(scope) {
	const absolute = path.join(root, scope);
	const stat = await import("node:fs/promises").then(({ stat }) => stat(absolute));
	if (!stat.isDirectory()) return [scope];
	const entries = await import("node:fs/promises").then(({ readdir }) => readdir(absolute, { withFileTypes: true }));
	const nested = await Promise.all(
		entries.map((entry) =>
			entry.isDirectory()
				? filesFor(path.join(scope, entry.name))
				: entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
					? [path.join(scope, entry.name)]
					: [],
		),
	);
	return nested.flat();
}

async function scan() {
	const findings = [];
	for (const [scope, kind] of scopes) {
		for (const file of await filesFor(scope)) {
			const source = await readFile(path.join(root, file), "utf8");
			const lines = source.split("\n");
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index];
				// Scan source code only; comments and strings cannot authorize an exemption.
				const code = line.replace(/\/\/.*$/, "");
				const presenterBacked = lines
					.slice(index, index + 8)
					.some((candidate) =>
						/\berror\s*:\s*presentActionableError\s*\(/.test(candidate.replace(/\/\/.*$/, "")),
					);
				if (patterns[kind].test(code) && !presenterBacked) findings.push({ file, kind, line: index + 1 });
			}
		}
	}
	return findings;
}

function grouped(findings) {
	const result = new Map();
	for (const finding of findings) {
		const key = `${finding.file}\0${finding.kind}`;
		result.set(key, { file: finding.file, kind: finding.kind, count: (result.get(key)?.count ?? 0) + 1 });
	}
	return [...result.values()].sort((a, b) => `${a.file}:${a.kind}`.localeCompare(`${b.file}:${b.kind}`));
}

let baseline;
try {
	baseline = JSON.parse(await readFile(baselinePath, "utf8"));
} catch (error) {
	console.error(`error-boundary-check: cannot read ${path.relative(root, baselinePath)}: ${error.message}`);
	process.exit(1);
}
const exemptions = baseline.exemptions ?? [];
if (
	!Array.isArray(exemptions) ||
	exemptions.some(
		(entry) =>
			!entry ||
			typeof entry !== "object" ||
			typeof entry.file !== "string" ||
			typeof entry.kind !== "string" ||
			typeof entry.owner !== "string" ||
			typeof entry.reason !== "string" ||
			typeof entry.externalComponent !== "string",
	)
) {
	console.error(
		"error-boundary-check: malformed exemption; require file, kind, owner, reason, and externalComponent",
	);
	process.exit(1);
}
const exemptionKeys = new Set(exemptions.map((entry) => `${entry.file}\\0${entry.kind}`));
const scanned = await scan();
const scannedKeys = new Set(scanned.map((finding) => `${finding.file}\\0${finding.kind}`));
if ([...exemptionKeys].some((key) => !scannedKeys.has(key))) {
	console.error("error-boundary-check: exemption does not match a current direct-render finding");
	process.exit(1);
}
const current = grouped(scanned.filter((finding) => !exemptionKeys.has(`${finding.file}\\0${finding.kind}`)));
if (mode === "init") {
	if (baseline.entries?.length) throw new Error("error-boundary-check: refusing to replace an existing baseline");
	await writeFile(
		baselinePath,
		`${JSON.stringify({ version: 1, exemptions: baseline.exemptions ?? [], entries: current }, null, "\t")}\n`,
	);
	console.log(`error-boundary-check: initialized (${current.length} entries)`);
	process.exit(0);
}
const previous = new Map((baseline.entries ?? []).map((entry) => [`${entry.file}\0${entry.kind}`, entry]));
const failures = current.filter(
	(entry) =>
		!previous.has(`${entry.file}\0${entry.kind}`) ||
		entry.count > previous.get(`${entry.file}\0${entry.kind}`).count,
);
if (failures.length) {
	console.error(
		"error-boundary-check: direct error renders increased; migrate through the shared presenter or add a reviewed exemption",
	);
	for (const failure of failures) console.error(`  ${failure.file} ${failure.kind}: ${failure.count}`);
	process.exit(1);
}
if (mode === "update") {
	await writeFile(
		baselinePath,
		`${JSON.stringify({ version: 1, exemptions: baseline.exemptions ?? [], entries: current }, null, "\t")}\n`,
	);
	console.log(`error-boundary-check: baseline ratcheted (${current.length} entries)`);
} else console.log(`error-boundary-check: PASS (${current.length} entries)`);
