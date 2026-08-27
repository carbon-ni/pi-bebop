import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyze, applyRatchet, updateBaseline } from "./arch-analysis.mjs";

const root = process.cwd();
const baselinePath = path.join(root, "arch-baseline.json");
const update = process.argv.includes("--update-baseline");

async function sourceFiles(dir) {
	const files = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			files.push(path.relative(root, file).split(path.sep).join("/"));
		}
	}
	return files;
}

const paths = (await sourceFiles(path.join(root, "src"))).sort();
const sources = [];
for (const relative of paths) {
	sources.push({ path: relative, source: await readFile(path.join(root, relative), "utf8") });
}

let baseline;
try {
	baseline = JSON.parse(await readFile(baselinePath, "utf8"));
} catch (error) {
	if (error.code === "ENOENT") {
		console.error(`arch-check: ${path.relative(root, baselinePath)} is missing; restore it from git history`);
		console.error("  (baseline entries may only shrink or be removed; never regenerate upward)");
		process.exit(1);
	}
	console.error(`arch-check: malformed ${path.relative(root, baselinePath)}: ${error.message}`);
	process.exit(1);
}

const analysis = analyze(sources);

if (update) {
	const next = updateBaseline(analysis, baseline);
	if (!next.ok) {
		console.error(`arch-check: refusing --update-baseline (${next.reason})`);
		for (const failure of next.failures)
			console.error(`  ${failure.check} ${failure.file ?? ""} ${failure.function ?? ""}`);
		process.exit(1);
	}
	await writeFile(baselinePath, `${JSON.stringify({ version: 1, entries: next.entries }, null, "\t")}\n`);
	console.log(
		`arch-check: baseline updated (${next.entries.length} entries; only shrinking and pruning are allowed)`,
	);
}

const result = applyRatchet(analysis, baseline);

console.log(
	`arch-check: ${analysis.files} files, ${analysis.functions} functions; limits: complexity>${15}, lines>500, layer graph, folder cycles`,
);

for (const failure of result.failures) {
	const where = `${failure.file ?? ""}${failure.line ? `:${failure.line}` : ""}`;
	if (failure.check === "layer") {
		console.log(`FAIL layer ${where} ${failure.fromLayer} -> ${failure.toLayer} (${failure.specifier})`);
	} else if (failure.check === "cycle") {
		console.log(`FAIL cycle ${failure.nodes.join(" <-> ")} (only allow-listed cycles are legal)`);
	} else if (failure.reason === "malformed-baseline") {
		console.log(`FAIL baseline entry malformed: ${JSON.stringify(failure)}`);
	} else if (failure.reason === "grew") {
		console.log(
			`FAIL ${failure.check} ${where} ${failure.function ?? ""} ${failure.baselineValue} -> ${failure.value} (baseline grew; ratchet only shrinks)`,
		);
	} else {
		console.log(
			`FAIL ${failure.check} ${where} ${failure.function ?? ""}=${failure.value} (limit ${failure.check === "complexity" ? 15 : 500})`,
		);
	}
}

for (const note of result.notes) console.log(`note ${note}`);
for (const cycle of analysis.cycles.filter((entry) => entry.allowed)) {
	console.log(`ok cycle ${cycle.nodes.join(" <-> ")} (allow-listed)`);
}

if (result.ok) {
	console.log("arch-check: no violations");
} else {
	console.log(`arch-check: ${result.failures.length} violation(s)`);
	process.exitCode = 1;
}
