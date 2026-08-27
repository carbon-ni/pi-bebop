import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ALLOWED_CYCLES,
	COMPLEXITY_LIMIT,
	FILE_LINE_LIMIT,
	LAYER_RULES,
	analyze,
	applyRatchet,
	lineCount,
	layerOf,
	updateBaseline,
} from "./arch-analysis.mjs";

const file = (path, source) => ({ path, source });

const emptyBaseline = { version: 1, entries: [] };

test("layerOf maps source paths to layers", () => {
	assert.equal(layerOf("src/domain/protocol.ts"), "domain");
	assert.equal(layerOf("src/domain/deep/nested.ts"), "domain");
	assert.equal(layerOf("src/infra/rpc-client.ts"), "infra");
	assert.equal(layerOf("src/cli/commands/send.ts"), "cli/commands");
	assert.equal(layerOf("src/cli/parser.ts"), "cli");
	assert.equal(layerOf("src/extension.ts"), "extension");
	assert.equal(layerOf("src/tools/send-follow-up.ts"), "tools");
	assert.equal(layerOf("src/application/member-message.ts"), "application");
});

test("cyclomatic complexity counts branches, logical operators, cases, catch, and ternary", () => {
	const source = `
function f(a: boolean, b: boolean, c: number | null) {
	let r = 0;
	if (a) r++;
	for (let i = 0; i < 1; i++) r++;
	for (const x of [1]) r++;
	for (const k in {}) r++;
	while (a) break;
	do r++; while (a);
	try { r++; } catch { r--; }
	switch (c) { case 1: r++; break; case 2: r--; break; default: break; }
	const t = a ? 1 : 2;
	const u = a && b;
	const v = a || b;
	const w = c ?? 0;
	r += t + u + v + w;
	return r;
}
`;
	const result = analyze([file("src/domain/f.ts", source)]);
	const fn = result.complexity.find((entry) => entry.function === "f");
	// 1 base + if, for, forof, forin, while, do, catch, 2 cases, ternary, &&, ||, ?? = 13 decisions
	assert.equal(fn?.value, 14);
	assert.equal(fn?.line, 2);
});

test("complexity excludes nested function bodies and counts them separately", () => {
	const source = `
const outer = (a: boolean) => {
	if (a) return 1;
	const inner = function (b: boolean) {
		if (b) return 2;
		if (!b) return 3;
		return 4;
	};
	return inner(a);
};
`;
	const result = analyze([file("src/domain/f.ts", source)]);
	const outer = result.complexity.find((entry) => entry.function === "outer");
	const inner = result.complexity.find((entry) => entry.function === "inner");
	assert.equal(outer?.value, 2); // named via variable declaration, only its own if
	assert.equal(inner?.value, 3);
});

test("complexity boundary: limit passes, limit plus one is an offender", () => {
	const at = (decisions) => `
function f(a: boolean) {
	let r = 0;
${Array.from({ length: decisions }, (_, i) => `\tif (a && a === ${i}) r++;`).join("\n")}
	return r;
}
`;
	// each line contributes an if and an && = 2 decisions; 7 lines = 14 decisions = cc 15
	const ok = analyze([file("src/domain/ok.ts", at(7))]).complexity[0];
	assert.equal(ok.value, 15);
	// 8 lines = 16 decisions = cc 17
	const bad = analyze([file("src/domain/bad.ts", at(8))]).complexity[0];
	assert.equal(bad.value, 17);

	const offenders = applyRatchet(
		analyze([file("src/domain/ok.ts", at(7)), file("src/domain/bad.ts", at(8))]),
		emptyBaseline,
	);
	assert.equal(offenders.ok, false);
	const failure = offenders.failures.find((entry) => entry.check === "complexity" && entry.function === "f");
	assert.equal(failure?.file, "src/domain/bad.ts");
	assert.equal(failure?.value, 17);
	assert.equal(failure?.reason, "new");
});

test("lineCount is newline-based and deterministic", () => {
	assert.equal(lineCount(""), 0);
	assert.equal(lineCount("a"), 1);
	assert.equal(lineCount("a\nb"), 2);
	assert.equal(lineCount("a\nb\n"), 2);
	assert.equal(lineCount("\n".repeat(500)), 500);
});

test("file-size boundary: 500 lines pass, 501 fail", () => {
	const okFile = file("src/domain/small.ts", "\n".repeat(500));
	const bigFile = file("src/domain/big.ts", "\n".repeat(501));
	const result = applyRatchet(analyze([okFile, bigFile]), emptyBaseline);
	assert.equal(result.ok, false);
	const failure = result.failures.find((entry) => entry.check === "file-size");
	assert.equal(failure?.file, "src/domain/big.ts");
	assert.equal(failure?.value, 501);
});

test("layer rules allow the documented graph", () => {
	const sources = [
		file("src/domain/pure.ts", "export const x = 1;\n"),
		file("src/infra/base.ts", `import { x } from "../domain/pure.ts";\nexport const y = x;\n`),
		file(
			"src/application/app.ts",
			`import { x } from "../domain/pure.ts";\nimport { y } from "../infra/base.ts";\nexport const z = x + y;\n`,
		),
		file(
			"src/pi/runtime.ts",
			`import { z } from "../application/app.ts";\nimport { x } from "../domain/pure.ts";\nimport { y } from "../infra/base.ts";\nexport const w = z + x + y;\n`,
		),
		file(
			"src/tools/tool.ts",
			`import { z } from "../application/app.ts";\nimport { x } from "../domain/pure.ts";\nimport { y } from "../infra/base.ts";\nexport const v = z + x + y;\n`,
		),
		file(
			"src/extension.ts",
			`import { v } from "./tools/tool.ts";\nimport { w } from "./pi/runtime.ts";\nexport const u = v + w;\n`,
		),
		file(
			"src/cli/entry.ts",
			`import { z } from "../application/app.ts";\nimport { x } from "../domain/pure.ts";\nimport { y } from "../infra/base.ts";\nimport { run } from "./commands/cmd.ts";\nexport const t = z + x + y + run;\n`,
		),
		file(
			"src/cli/commands/cmd.ts",
			`import { t } from "../entry.ts";\nimport { z } from "../../application/app.ts";\nexport const run = t + z;\n`,
		),
	];
	const result = analyze(sources);
	assert.deepEqual(result.layerViolations, []);
	const cycles = result.cycles.map((cycle) => cycle.nodes);
	assert.deepEqual(cycles, [["cli", "cli/commands"]]);
	assert.equal(result.cycles[0].allowed, true);
	assert.equal(applyRatchet(result, emptyBaseline).ok, true);
});

test("layer violations fail on illegal cross-layer imports (sabotage: domain imports infra)", () => {
	const sources = [
		file("src/domain/impure.ts", `import { y } from "../infra/base.ts";\nexport const x = y;\n`),
		file("src/infra/base.ts", "export const y = 1;\n"),
	];
	const result = applyRatchet(analyze(sources), emptyBaseline);
	assert.equal(result.ok, false);
	const failure = result.failures.find((entry) => entry.check === "layer");
	assert.equal(failure.file, "src/domain/impure.ts");
	assert.equal(failure.fromLayer, "domain");
	assert.equal(failure.toLayer, "infra");
	assert.equal(failure.reason, "layer");
});

test("cli importing pi or tools is a layer violation", () => {
	const sources = [
		file("src/pi/runtime.ts", "export const w = 1;\n"),
		file("src/tools/tool.ts", "export const v = 2;\n"),
		file(
			"src/cli/entry.ts",
			`import { w } from "../pi/runtime.ts";\nimport { v } from "../tools/tool.ts";\nexport const t = w + v;\n`,
		),
	];
	const result = applyRatchet(analyze(sources), emptyBaseline);
	assert.equal(result.ok, false);
	const layers = result.failures.filter((entry) => entry.check === "layer").map((entry) => entry.toLayer);
	assert.deepEqual(layers.sort(), ["pi", "tools"]);
});

test("unknown top-level src folders fail the layer check", () => {
	const sources = [file("src/experiment/lab.ts", "export const n = 1;\n")];
	const result = applyRatchet(analyze(sources), emptyBaseline);
	assert.equal(result.ok, false);
	assert.ok(
		result.failures.some(
			(entry) =>
				entry.check === "layer" && entry.reason === "unknown-layer" && entry.file === "src/experiment/lab.ts",
		),
	);
});

test("unallowed folder cycles fail even when layer direction is individually legal (sabotage)", () => {
	const sources = [
		file("src/domain/a.ts", `import { b } from "../infra/b.ts";\nexport const a = b;\n`),
		file(
			"src/infra/b.ts",
			`import { x } from "../domain/pure.ts";\nimport { a } from "../domain/a.ts";\nexport const b = a;\n`,
		),
		file("src/domain/pure.ts", "export const x = 1;\n"),
	];
	const result = applyRatchet(analyze(sources), emptyBaseline);
	assert.equal(result.ok, false);
	const cycle = result.failures.find((entry) => entry.check === "cycle");
	assert.deepEqual(cycle?.nodes, ["domain", "infra"]);
});

test("import resolution supports .ts, extension-less, .js, and directory index specifiers", () => {
	const sources = [
		file("src/domain/aliased.ts", `export const q = 1;\n`),
		file("src/domain/b.ts", "export const r = 2;\n"),
		file("src/domain/c.ts", "export const s = 3;\n"),
		file("src/domain/sub/index.ts", "export const t = 4;\n"),
		file(
			"src/infra/imports.ts",
			[
				'import { q } from "../domain/aliased.ts";',
				'import { r } from "../domain/b";',
				'import { s } from "../domain/c.js";',
				'import { t } from "../domain/sub";',
				"export const u = q + r + s + t;",
			].join("\n"),
		),
	];
	const result = analyze(sources);
	assert.deepEqual(result.layerViolations, []);
});

test("dynamic import() specifiers are checked too", () => {
	const sources = [
		file("src/domain/lazy.ts", 'const mod = await import("../infra/base.ts");\nexport default mod;\n'),
		file("src/infra/base.ts", "export const y = 1;\n"),
	];
	const result = applyRatchet(analyze(sources), emptyBaseline);
	assert.equal(result.ok, false);
	assert.ok(result.failures.some((entry) => entry.check === "layer" && entry.file === "src/domain/lazy.ts"));
});

test("type-only cross-layer imports are not runtime coupling", () => {
	const sources = [
		file(
			"src/domain/types-only.ts",
			'import type { Y } from "../infra/base.ts";\nimport { type Z } from "../infra/base.ts";\nexport const x = 1;\n',
		),
		file("src/infra/base.ts", "export type Y = number;\nexport type Z = string;\nexport const v = 2;\n"),
	];
	const clean = analyze(sources);
	assert.deepEqual(clean.layerViolations, []);
	assert.deepEqual(clean.cycles, []);

	const mixed = [
		file("src/domain/mixed.ts", 'import { v, type Y } from "../infra/base.ts";\nexport const x = v;\n'),
		file("src/infra/base.ts", "export type Y = number;\nexport const v = 2;\n"),
	];
	const violation = applyRatchet(analyze(mixed), emptyBaseline);
	assert.equal(violation.ok, false);
	assert.ok(violation.failures.some((entry) => entry.check === "layer" && entry.file === "src/domain/mixed.ts"));
});

test("external and builtin imports are never layer violations", () => {
	const sources = [
		file(
			"src/domain/external.ts",
			'import { Type } from "@sinclair/typebox";\nimport path from "node:path";\nexport const z = path;\n',
		),
	];
	assert.equal(applyRatchet(analyze(sources), emptyBaseline).ok, true);
});

test("ratchet accepts a baseline entry at current value and fails on growth", () => {
	const source = `
function f(a: boolean) {
	let r = 0;
${Array.from({ length: 16 }, (_, i) => `\tif (a && a === ${i}) r++;`).join("\n")}
	return r;
}
`;
	// 16 lines x 2 decisions = 32 decisions = cc 33
	const current = analyze([file("src/domain/f.ts", source)]);
	const measured = current.complexity.find((entry) => entry.function === "f").value;

	const atValue = applyRatchet(current, {
		version: 1,
		entries: [{ check: "complexity", file: "src/domain/f.ts", function: "f", value: measured }],
	});
	assert.equal(atValue.ok, true);

	const grown = applyRatchet(current, {
		version: 1,
		entries: [{ check: "complexity", file: "src/domain/f.ts", function: "f", value: measured - 1 }],
	});
	assert.equal(grown.ok, false);
	const failure = grown.failures.find((entry) => entry.check === "complexity");
	assert.equal(failure.reason, "grew");
	assert.equal(failure.baselineValue, measured - 1);
	assert.equal(failure.value, measured);
});

test("ratchet notes shrunk and stale baseline entries but stays green", () => {
	const source = `
function f(a: boolean) {
	let r = 0;
${Array.from({ length: 10 }, (_, i) => `\tif (a && a === ${i}) r++;`).join("\n")}
	return r;
}
`;
	// 20 decisions = cc 21, baseline says 33
	const current = analyze([file("src/domain/f.ts", source)]);
	const result = applyRatchet(current, {
		version: 1,
		entries: [
			{ check: "complexity", file: "src/domain/f.ts", function: "f", value: 33 },
			{ check: "file-size", file: "src/domain/gone.ts", value: 600 },
		],
	});
	assert.equal(result.ok, true);
	assert.ok(result.notes.some((note) => note.includes("src/domain/f.ts") && note.includes("can shrink")));
	assert.ok(result.notes.some((note) => note.includes("src/domain/gone.ts") && note.includes("stale")));
});

test("layer violations are never ratcheted, even with a baseline entry", () => {
	const sources = [
		file("src/domain/impure.ts", `import { y } from "../infra/base.ts";\nexport const x = y;\n`),
		file("src/infra/base.ts", "export const y = 1;\n"),
	];
	const result = applyRatchet(analyze(sources), {
		version: 1,
		entries: [{ check: "layer", file: "src/domain/impure.ts", value: 1 }],
	});
	assert.equal(result.ok, false);
});

test("baseline schema errors fail closed", () => {
	const current = analyze([file("src/domain/pure.ts", "export const x = 1;\n")]);
	const duplicate = applyRatchet(current, {
		version: 1,
		entries: [
			{ check: "file-size", file: "src/domain/a.ts", value: 600 },
			{ check: "file-size", file: "src/domain/a.ts", value: 700 },
		],
	});
	assert.equal(duplicate.ok, false);
	assert.ok(duplicate.failures.some((entry) => entry.reason === "malformed-baseline"));

	const unknownCheck = applyRatchet(current, {
		version: 1,
		entries: [{ check: "nope", file: "src/domain/a.ts", value: 1 }],
	});
	assert.equal(unknownCheck.ok, false);
});

test("updateBaseline only shrinks and prunes", () => {
	const source = `
function f(a: boolean) {
	let r = 0;
${Array.from({ length: 10 }, (_, i) => `\tif (a && a === ${i}) r++;`).join("\n")}
	return r;
}
`;
	const current = analyze([file("src/domain/f.ts", source)]); // cc 21
	const baseline = {
		version: 1,
		entries: [
			{ check: "complexity", file: "src/domain/f.ts", function: "f", value: 33 },
			{ check: "file-size", file: "src/domain/gone.ts", value: 600 },
		],
	};
	const updated = updateBaseline(current, baseline);
	assert.equal(updated.ok, true);
	assert.deepEqual(updated.entries, [{ check: "complexity", file: "src/domain/f.ts", function: "f", value: 21 }]);
});

test("updateBaseline refuses to add or grow entries", () => {
	const offender = `
function f(a: boolean) {
	let r = 0;
${Array.from({ length: 8 }, (_, i) => `\tif (a && a === ${i}) r++;`).join("\n")}
	return r;
}
`;
	const newOffender = updateBaseline(analyze([file("src/domain/f.ts", offender)]), emptyBaseline);
	assert.equal(newOffender.ok, false);
	assert.equal(newOffender.reason, "new");

	const grown = updateBaseline(analyze([file("src/domain/f.ts", offender)]), {
		version: 1,
		entries: [{ check: "complexity", file: "src/domain/f.ts", function: "f", value: 10 }],
	});
	assert.equal(grown.ok, false);
	assert.equal(grown.reason, "grew");

	const layered = updateBaseline(
		analyze([
			file("src/domain/impure.ts", `import { y } from "../infra/base.ts";\nexport const x = y;\n`),
			file("src/infra/base.ts", "export const y = 1;\n"),
		]),
		emptyBaseline,
	);
	assert.equal(layered.ok, false);
	assert.equal(layered.reason, "violations");
});

test("anonymous functions get deterministic identities and cannot bypass the ceiling", () => {
	const callback = [
		"export const items = [1];",
		"items.forEach((a: boolean) => {",
		"\tlet r = 0;",
		...Array.from({ length: 8 }, (_, i) => `\tif (a && a === ${i}) r++;`),
		"\treturn void r;",
		"});",
	].join("\n");
	const result = analyze([file("src/domain/anon.ts", callback)]);
	const fn = result.complexity.find((entry) => entry.function.startsWith("anonymous@"));
	assert.ok(fn, `expected an anonymous@ identity, got ${JSON.stringify(result.complexity)}`);
	assert.equal(fn.function, "anonymous@2");
	assert.equal(fn.value, 17);
	assert.equal(fn.line, 2);

	const clean = analyze([
		file("src/domain/anon-ok.ts", "export const items = [1];\nitems.forEach((a: boolean) => a || !a);\n"),
	]);
	assert.equal(clean.complexity.find((entry) => entry.function === "anonymous@2")?.value, 2);
});

test("single-line anonymous map callbacks are counted as complexity offenders", () => {
	const source = [
		"export const items=[true].map((a)=>{",
		...Array.from({ length: 16 }, (_, i) => `\tif (a) value${i}++;`),
		"});",
	].join("\n");
	const result = analyze([file("src/domain/anonymous-map.ts", source)]);
	assert.deepEqual(result.complexity, [
		{ file: "src/domain/anonymous-map.ts", function: "anonymous@1", line: 1, value: 17 },
	]);
	const ratchet = applyRatchet(result, emptyBaseline);
	assert.equal(ratchet.ok, false);
	assert.deepEqual(ratchet.failures, [{
		check: "complexity",
		file: "src/domain/anonymous-map.ts",
		function: "anonymous@1",
		line: 1,
		value: 17,
		reason: "new",
	}]);
});

test("class-property arrows are named by the property", () => {
	const source = [
		"export class Runner {",
		"\thandler = (a: boolean) => {",
		"\t\tif (a && a) return 1;",
		"\t\treturn 0;",
		"\t};",
		"}",
	].join("\n");
	const result = analyze([file("src/domain/runner.ts", source)]);
	assert.ok(result.complexity.some((entry) => entry.function === "handler"));
});

test("constants expose the documented policy", () => {
	assert.equal(COMPLEXITY_LIMIT, 15);
	assert.equal(FILE_LINE_LIMIT, 500);
	assert.deepEqual(LAYER_RULES.domain, []);
	assert.deepEqual(LAYER_RULES.cli, ["application", "cli", "cli/commands", "domain", "infra"]);
	assert.ok(!LAYER_RULES.cli.includes("pi"));
	assert.ok(!LAYER_RULES.cli.includes("tools"));
	assert.deepEqual(ALLOWED_CYCLES, [["cli", "cli/commands"]]);
	assert.deepEqual(LAYER_RULES.extension, ["application", "cli", "cli/commands", "domain", "infra", "pi", "tools"]);
});

// ---------------------------------------------------------------------------
// Executable gate fixtures (Kelly's acceptance criterion): run the real
// scripts/arch-check.mjs CLI against generated fixture trees and assert
// deterministic diagnostics. Each sabotage case is independent: exactly one
// FAIL line, byte-exact.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const runGate = (root) =>
	spawnSync(process.execPath, [join(here, "arch-check.mjs"), "--root", root], { encoding: "utf8" });
const failLines = (stdout) => stdout.split("\n").filter((line) => line.startsWith("FAIL"));

/** Fixture tree: one ratcheted cc offender, one ratcheted file-size offender, clean layering. */
async function fixtureTree() {
	const root = await mkdtemp(join("/tmp", "bebop-arch-fixture-"));
	await mkdir(join(root, "src/domain"), { recursive: true });
	await mkdir(join(root, "src/infra"), { recursive: true });
	await writeFile(
		join(root, "src/domain/complex.ts"),
		[
			"export function offender(a: boolean) {",
			"\tlet r = 0;",
			...Array.from({ length: 8 }, (_, i) => `\tif (a && a === ${i}) r++;`),
			"\treturn r;",
			"}",
		].join("\n"),
	);
	await writeFile(join(root, "src/domain/pure.ts"), "export const x = 1;\n");
	await writeFile(join(root, "src/domain/big.ts"), "\n".repeat(501));
	await writeFile(join(root, "src/infra/base.ts"), "export const y = 1;\n");
	const baseline = {
		version: 1,
		entries: [
			{ check: "complexity", file: "src/domain/complex.ts", function: "offender", value: 17 },
			{ check: "file-size", file: "src/domain/big.ts", value: 501 },
		],
	};
	await writeFile(join(root, "arch-baseline.json"), `${JSON.stringify(baseline, null, "\t")}\n`);
	return root;
}

test("gate fixture: ratcheted baseline passes (executable proof)", async () => {
	const root = await fixtureTree();
	try {
		const result = runGate(root);
		assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
		assert.match(result.stdout, /arch-check: no violations/);
		assert.deepEqual(failLines(result.stdout), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("gate fixture: new complexity offender independently fails with exact diagnostics", async () => {
	const root = await fixtureTree();
	try {
		await writeFile(
			join(root, "src/domain/sabotage-complexity.ts"),
			[
				"export function sabotage(a: boolean) {",
				"\tlet r = 0;",
				...Array.from({ length: 8 }, (_, i) => `\tif (a && a === ${i}) r++;`),
				"\treturn r;",
				"}",
			].join("\n"),
		);
		const result = runGate(root);
		assert.equal(result.status, 1);
		assert.deepEqual(failLines(result.stdout), [
			"FAIL complexity src/domain/sabotage-complexity.ts:1 sabotage=17 (limit 15)",
		]);
		assert.match(result.stdout, /arch-check: 1 violation\(s\)/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("gate fixture: illegal cross-layer import independently fails with exact diagnostics", async () => {
	const root = await fixtureTree();
	try {
		await writeFile(
			join(root, "src/domain/sabotage-layer.ts"),
			'import { y } from "../infra/base.ts";\nexport const sabotage = y;\n',
		);
		const result = runGate(root);
		assert.equal(result.status, 1);
		assert.deepEqual(failLines(result.stdout), [
			"FAIL layer src/domain/sabotage-layer.ts:1 domain -> infra (../infra/base.ts)",
		]);
		assert.match(result.stdout, /arch-check: 1 violation\(s\)/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("gate fixture: removing a baseline entry re-fails its offender (ratchet is load-bearing)", async () => {
	const root = await fixtureTree();
	try {
		const baseline = JSON.parse(await readFile(join(root, "arch-baseline.json"), "utf8"));
		baseline.entries = baseline.entries.filter((entry) => entry.check !== "file-size");
		await writeFile(join(root, "arch-baseline.json"), `${JSON.stringify(baseline, null, "\t")}\n`);
		const result = runGate(root);
		assert.equal(result.status, 1);
		assert.deepEqual(failLines(result.stdout), ["FAIL file-size src/domain/big.ts =501 (limit 500)"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("gate fixture: baseline function grown by one decision fails as baseline growth", async () => {
	const root = await fixtureTree();
	try {
		const baseline = JSON.parse(await readFile(join(root, "arch-baseline.json"), "utf8"));
		// offender measures 17 today; record 16 so the tree has grown by one decision
		const entry = baseline.entries.find((item) => item.check === "complexity");
		entry.value = 16;
		await writeFile(join(root, "arch-baseline.json"), `${JSON.stringify(baseline, null, "\t")}\n`);
		const result = runGate(root);
		assert.equal(result.status, 1);
		assert.deepEqual(failLines(result.stdout), [
			"FAIL complexity src/domain/complex.ts:1 offender 16 -> 17 (baseline grew; ratchet only shrinks)",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("gate fixture: non-allowlisted folder cycle fails and is identified as a cycle", async () => {
	const root = await fixtureTree();
	try {
		// close a domain <-> infra folder cycle: domain/pure imports infra/base and vice versa
		await writeFile(
			join(root, "src/domain/pure.ts"),
			'import { y } from "../infra/base.ts";\nexport const x = y;\n',
		);
		await writeFile(
			join(root, "src/infra/base.ts"),
			'import { x } from "../domain/pure.ts";\nexport const y = x ?? 1;\n',
		);
		const result = runGate(root);
		assert.equal(result.status, 1);
		const fails = failLines(result.stdout);
		assert.ok(
			fails.includes("FAIL cycle domain <-> infra (only allow-listed cycles are legal)"),
			`expected cycle diagnostic in ${JSON.stringify(fails)}`,
		);
		// the domain -> infra import is also an illegal layer direction; both diagnostics are expected
		assert.ok(fails.some((line) => line.startsWith("FAIL layer src/domain/pure.ts")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("gate fixture: clean tree below the ceilings exits zero with an empty baseline", async () => {
	const root = await mkdtemp(join("/tmp", "bebop-arch-clean-"));
	try {
		await mkdir(join(root, "src/domain"), { recursive: true });
		await mkdir(join(root, "src/infra"), { recursive: true });
		await writeFile(join(root, "src/domain/pure.ts"), "export const x = 1;\n");
		await writeFile(
			join(root, "src/infra/base.ts"),
			'import { x } from "../domain/pure.ts";\nexport const y = x;\n',
		);
		await writeFile(join(root, "arch-baseline.json"), '{"version":1,"entries":[]}\n');
		const result = runGate(root);
		assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
		assert.match(result.stdout, /arch-check: no violations/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("gate: committed repository passes with the committed baseline", () => {
	const repoRoot = join(here, "..");
	const result = spawnSync(process.execPath, [join(here, "arch-check.mjs")], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	assert.deepEqual(failLines(result.stdout), []);
});

test("gate fixture: anonymous callback sabotage independently fails (bypass regression)", async () => {
	const root = await fixtureTree();
	try {
		await writeFile(
			join(root, "src/domain/sabotage-anon.ts"),
			[
				"export const items = [1];",
				"items.forEach((a: boolean) => {",
				"\tlet r = 0;",
				...Array.from({ length: 8 }, (_, i) => `\tif (a && a === ${i}) r++;`),
				"\treturn void r;",
				"});",
			].join("\n"),
		);
		const result = runGate(root);
		assert.equal(result.status, 1);
		assert.deepEqual(failLines(result.stdout), [
			"FAIL complexity src/domain/sabotage-anon.ts:2 anonymous@2=17 (limit 15)",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
