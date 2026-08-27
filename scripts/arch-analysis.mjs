import path from "node:path";
import ts from "typescript";

/**
 * Architecture guardrails analysis (TASK-0100).
 *
 * Deterministic structural checks over the TypeScript AST:
 *   1. per-function cyclomatic complexity
 *   2. per-file line count
 *   3. layer direction (import allow-list) + folder cycles
 *
 * The ratchet policy lives in `arch-baseline.json` at the repo root:
 * entries may only shrink or be removed. New offenders and growth fail.
 */

export const COMPLEXITY_LIMIT = 15;
export const FILE_LINE_LIMIT = 500;

/**
 * Verified module graph (see .tmp/reports/13-04-26/codebase-map.md).
 * Keys are layer names, values are the layers they may import.
 * Same-layer imports are always allowed and produce no graph edge.
 * cli must never import pi/tools (the CLI stays Pi-runtime-free).
 */
export const LAYER_RULES = {
	domain: [],
	infra: ["domain"],
	application: ["domain", "infra"],
	pi: ["application", "domain", "infra"],
	tools: ["application", "domain", "infra"],
	extension: ["application", "domain", "infra", "pi", "tools"],
	cli: ["application", "cli", "cli/commands", "domain", "infra"],
	"cli/commands": ["application", "cli", "domain", "infra"],
};

/** The only legal folder cycle: the cli <-> cli/commands mutual acquaintance. */
export const ALLOWED_CYCLES = [["cli", "cli/commands"]];

const LOGICAL_OPERATORS = new Set([
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.QuestionQuestionToken,
]);

const BRANCH_KINDS = new Set([
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement,
	ts.SyntaxKind.CaseClause,
	ts.SyntaxKind.CatchClause,
	ts.SyntaxKind.ConditionalExpression,
]);

function isFunctionLike(node) {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

function displayName(node) {
	if (ts.isConstructorDeclaration(node)) {
		const parent = node.parent;
		if (ts.isClassDeclaration(parent) && parent.name) return `${parent.name.text}.constructor`;
		return null;
	}
	if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
		const parent = node.parent;
		if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
		if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && !/^[0-9]/.test(parent.name.text)) {
			return parent.name.text;
		}
		return null;
	}
	return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
}

/** One base path plus control-flow and logical-branch decision points; nested functions excluded. */
function countDecisions(functionNode) {
	let decisions = 0;
	const visit = (node) => {
		if (node !== functionNode && isFunctionLike(node)) return;
		if (BRANCH_KINDS.has(node.kind)) decisions += 1;
		if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) decisions += 1;
		ts.forEachChild(node, visit);
	};
	visit(functionNode);
	return decisions;
}

function measureComplexity(sourceFile, filePath) {
	const rows = [];
	const visit = (node) => {
		if (isFunctionLike(node)) {
			const name = displayName(node);
			if (name) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
				rows.push({ file: filePath, function: name, line: line + 1, value: 1 + countDecisions(node) });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return rows;
}

/** Type-only imports are erased at build time and carry no runtime coupling. */
function isTypeOnlyImport(node) {
	if (ts.isImportDeclaration(node)) {
		const clause = node.importClause;
		if (!clause) return false; // side-effect import
		if (clause.isTypeOnly) return true;
		const named = clause.namedBindings;
		if (!named || !ts.isNamedImports(named)) return false;
		return named.elements.length > 0 && named.elements.every((element) => element.isTypeOnly);
	}
	if (ts.isExportDeclaration(node)) return node.isTypeOnly;
	return false;
}

function collectImportSpecifiers(sourceFile) {
	const specifiers = [];
	const visit = (node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			if (!isTypeOnlyImport(node))
				specifiers.push({ specifier: node.moduleSpecifier.text, line: getLine(sourceFile, node) });
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			if (!isTypeOnlyImport(node))
				specifiers.push({ specifier: node.moduleSpecifier.text, line: getLine(sourceFile, node) });
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			specifiers.push({ specifier: node.arguments[0].text, line: getLine(sourceFile, node) });
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return specifiers;
}

function getLine(sourceFile, node) {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** wc(1)-like line count: trailing newline does not add a line. */
export function lineCount(source) {
	if (source === "") return 0;
	return source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
}

/** "src/domain/deep/x.ts" -> "domain"; "src/cli/commands/x.ts" -> "cli/commands"; src root -> file stem. */
export function layerOf(filePath) {
	const parts = filePath.split("/");
	if (parts[0] !== "src" || parts.length < 2) return undefined;
	if (parts.length === 2) return parts[1].replace(/\.tsx?$/, "");
	if (parts[1] === "cli" && parts[2] === "commands") return "cli/commands";
	return parts[1];
}

function resolveLocal(specifier, fromPath, fileMap) {
	if (!specifier.startsWith(".")) return null;
	const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
	const candidates = [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, ".ts")];
	return candidates.find((candidate) => fileMap.has(candidate)) ?? null;
}

function detectCycles(edges) {
	const adjacency = new Map();
	for (const [from, to] of edges) {
		if (!adjacency.has(from)) adjacency.set(from, []);
		adjacency.get(from).push(to);
	}
	const index = new Map();
	const low = new Map();
	const onStack = new Set();
	const stack = [];
	const cycles = [];
	let counter = 0;

	const strongConnect = (node) => {
		index.set(node, counter);
		low.set(node, counter);
		counter += 1;
		stack.push(node);
		onStack.add(node);
		for (const next of adjacency.get(node) ?? []) {
			if (!index.has(next)) {
				strongConnect(next);
				low.set(node, Math.min(low.get(node), low.get(next)));
			} else if (onStack.has(next)) {
				low.set(node, Math.min(low.get(node), index.get(next)));
			}
		}
		if (low.get(node) === index.get(node)) {
			const component = [];
			let member;
			do {
				member = stack.pop();
				onStack.delete(member);
				component.push(member);
			} while (member !== node);
			if (component.length > 1) cycles.push([...component].sort());
		}
	};

	const nodes = [...new Set([...adjacency.keys(), ...adjacency.values()])].sort();
	for (const node of nodes) {
		if (!index.has(node)) strongConnect(node);
	}
	return cycles.sort((a, b) => a.join().localeCompare(b.join()));
}

const allowedCycleKeys = new Set(ALLOWED_CYCLES.map((cycle) => [...cycle].sort().join("\u0000")));

/**
 * Analyze a set of source files (paths repo-root relative, e.g. "src/domain/protocol.ts").
 * Pure and deterministic: same inputs, same output. No filesystem access.
 */
export function analyze(sources) {
	const fileMap = new Map(sources.map((entry) => [entry.path, entry.source]));
	const complexity = [];
	const fileSizes = [];
	const layerViolations = [];
	const edges = new Set();

	for (const entry of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
		const sourceFile = ts.createSourceFile(
			entry.path,
			entry.source,
			ts.ScriptTarget.ES2022,
			true,
			ts.ScriptKind.TS,
		);
		fileSizes.push({ file: entry.path, lines: lineCount(entry.source) });
		complexity.push(...measureComplexity(sourceFile, entry.path));

		const fromLayer = layerOf(entry.path);
		if (!fromLayer || !LAYER_RULES[fromLayer]) {
			layerViolations.push({
				file: entry.path,
				line: 0,
				fromLayer: fromLayer ?? "unknown",
				toLayer: "unknown",
				specifier: "",
				reason: "unknown-layer",
			});
		}
		for (const { specifier, line } of collectImportSpecifiers(sourceFile)) {
			const target = resolveLocal(specifier, entry.path, fileMap);
			if (!target) continue;
			const toLayer = layerOf(target);
			if (!toLayer || toLayer === fromLayer) continue;
			// Edges mirror the actual import graph (legal or not) so cycles are never hidden.
			edges.add(`${fromLayer ?? "unknown"}\u0000${toLayer}`);
			if (fromLayer && LAYER_RULES[fromLayer]?.includes(toLayer)) continue;
			layerViolations.push({
				file: entry.path,
				line,
				fromLayer: fromLayer ?? "unknown",
				toLayer,
				specifier,
				reason: !fromLayer || !LAYER_RULES[fromLayer] ? "unknown-layer" : "layer",
			});
		}
	}

	const cycles = detectCycles([...edges].map((edge) => edge.split("\u0000"))).map((nodes) => ({
		nodes,
		allowed: allowedCycleKeys.has(nodes.join("\u0000")),
	}));

	return {
		files: fileMap.size,
		functions: complexity.length,
		complexity: complexity.sort((a, b) => a.file.localeCompare(b.file) || a.function.localeCompare(b.function)),
		fileSizes: fileSizes.sort((a, b) => a.file.localeCompare(b.file)),
		layerViolations: layerViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
		cycles,
	};
}

const ratchetKey = (offender) =>
	offender.check === "complexity" ? `complexity|${offender.file}|${offender.function}` : `file-size|${offender.file}`;

function offendersOf(analysis) {
	return [
		...analysis.complexity
			.filter((entry) => entry.value > COMPLEXITY_LIMIT)
			.map((entry) => ({
				check: "complexity",
				file: entry.file,
				function: entry.function,
				line: entry.line,
				value: entry.value,
			})),
		...analysis.fileSizes
			.filter((entry) => entry.lines > FILE_LINE_LIMIT)
			.map((entry) => ({ check: "file-size", file: entry.file, value: entry.lines })),
	].sort((a, b) => ratchetKey(a).localeCompare(ratchetKey(b)));
}

/**
 * Apply the ratchet: baseline entries may only shrink or be removed.
 * Layer violations and folder cycles are never ratchetable.
 */
export function applyRatchet(analysis, baseline) {
	const failures = [];
	const notes = [];
	const seen = new Set();
	const baselineMap = new Map();

	for (const entry of baseline?.entries ?? []) {
		const failure = {
			check: entry.check,
			file: entry.file,
			function: entry.function,
			reason: "malformed-baseline",
		};
		if (entry.check !== "complexity" && entry.check !== "file-size") {
			failures.push(failure);
			continue;
		}
		if (typeof entry.file !== "string") {
			failures.push(failure);
			continue;
		}
		if (entry.check === "complexity" && typeof entry.function !== "string") {
			failures.push(failure);
			continue;
		}
		if (typeof entry.value !== "number" || entry.value < 0) {
			failures.push(failure);
			continue;
		}
		const key = ratchetKey(entry);
		if (seen.has(key)) {
			failures.push({ ...failure, reason: "malformed-baseline", detail: "duplicate entry" });
			continue;
		}
		seen.add(key);
		baselineMap.set(key, entry);
	}

	for (const violation of analysis.layerViolations) {
		failures.push({
			check: "layer",
			reason: violation.reason,
			file: violation.file,
			line: violation.line,
			fromLayer: violation.fromLayer,
			toLayer: violation.toLayer,
			specifier: violation.specifier,
		});
	}

	for (const cycle of analysis.cycles) {
		if (!cycle.allowed) failures.push({ check: "cycle", reason: "cycle", nodes: cycle.nodes });
	}

	for (const offender of offendersOf(analysis)) {
		const key = ratchetKey(offender);
		const entry = baselineMap.get(key);
		if (!entry) {
			failures.push({ ...offender, reason: "new" });
		} else if (offender.value > entry.value) {
			failures.push({ ...offender, reason: "grew", baselineValue: entry.value });
		} else if (offender.value < entry.value) {
			notes.push(`${key}: ${entry.value} -> ${offender.value} (can shrink via --update-baseline)`);
			baselineMap.delete(key);
			continue;
		}
		baselineMap.delete(key);
	}

	for (const [key, entry] of [...baselineMap].sort((a, b) => a[0].localeCompare(b[0]))) {
		notes.push(`${key}: stale (offender resolved; remove via --update-baseline), recorded ${entry.value}`);
	}

	failures.sort(
		(a, b) =>
			(a.check ?? "").localeCompare(b.check ?? "") ||
			(a.file ?? "").localeCompare(b.file ?? "") ||
			(a.function ?? "").localeCompare(b.function ?? "") ||
			(a.line ?? 0) - (b.line ?? 0),
	);

	return { ok: failures.length === 0, failures, notes };
}

/**
 * Compute the next baseline. Refuses whenever anything would be added or grow,
 * or when layer/cycle violations exist. Only shrinking values and pruning
 * stale entries is permitted.
 */
export function updateBaseline(analysis, baseline) {
	const result = applyRatchet(analysis, baseline);
	if (!result.ok) {
		const blocking = result.failures.find(
			(failure) =>
				failure.check === "layer" || failure.check === "cycle" || failure.reason === "malformed-baseline",
		);
		return {
			ok: false,
			reason: blocking ? "violations" : (result.failures.find((f) => f.reason === "grew")?.reason ?? "new"),
			failures: result.failures,
		};
	}
	const previous = new Map((baseline?.entries ?? []).map((entry) => [ratchetKey(entry), entry]));
	const entries = offendersOf(analysis)
		.map((offender) => {
			const prior = previous.get(ratchetKey(offender));
			return { ...offender, value: Math.min(offender.value, prior?.value ?? offender.value) };
		})
		.map(({ check, file, function: fn, value }) =>
			check === "complexity" ? { check, file, function: fn, value } : { check, file, value },
		);
	return { ok: true, entries };
}
