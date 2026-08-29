import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const watchConfig = readFileSync(resolve(root, ".watch.yaml"), "utf8");
const ciConfig = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
const prePush = readFileSync(resolve(root, ".githooks/pre-push"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const failureNotifier = readFileSync(resolve(root, "scripts/notify-crew-on-watch-failure.sh"), "utf8");

function jobSection(name) {
	const start = watchConfig.indexOf(`name: ${name}`);
	assert.notEqual(start, -1, `missing watcher job: ${name}`);
	const nextJob = watchConfig.indexOf("\n    - name:", start + 1);
	return watchConfig.slice(start, nextJob === -1 ? undefined : nextJob);
}

test("final watcher gate covers every non-ignored repository input", () => {
	const finalGate = jobSection("quality gate @agent-final");

	assert.match(finalGate, /run: make all/);
	assert.match(finalGate, /change:\s*["']\*\*\/\*["']/);
	assert.match(watchConfig, /respect_gitignore:\s*true/);
	assert.match(readFileSync(resolve(root, ".gitignore"), "utf8"), /^\.bebop-build\.lock\/$/m);
	assert.match(readFileSync(resolve(root, ".gitignore"), "utf8"), /^\.bebop-build-\*\/$/m);
	for (const ignoredPath of [".git/**", ".tmp/**", ".pi/**", "node_modules/**", "coverage/**", '"**/*.log"']) {
		assert.ok(watchConfig.includes(`- ${ignoredPath}`), `missing ignored path: ${ignoredPath}`);
	}
});

test("failed watcher generations notify the crew after a quiet period", () => {
	assert.match(watchConfig, /debounce: 2s/);
	assert.match(watchConfig, /hooks:\s*\n\s+failure:\s+scripts\/notify-crew-on-watch-failure\.sh/);
	assert.match(failureNotifier, /QUIET_PERIOD_SECONDS=5/);
	assert.match(failureNotifier, /pi-bebop crew broadcast/);
	assert.doesNotMatch(watchConfig, /^\s+recovery(?:_policy)?:/m);
});

test("CI and local final verification invoke the canonical make all gate", () => {
	assert.match(ciConfig, /- run: make all/);
	assert.match(jobSection("quality gate @agent-final"), /run: make all/);
});

test("quick watcher jobs remain targeted instead of inheriting the final gate trigger", () => {
	for (const job of ["test @quick", "format @quick", "lint @quick", "security audit @quick"]) {
		const section = jobSection(job);
		assert.doesNotMatch(section, /change:\s*["']\*\*\/\*["']/);
	}
});

test("repository hooks have an explicit install and check path", () => {
	assert.match(makefile, /^hooks-install:$/m);
	assert.match(makefile, /git config core\.hooksPath \.githooks/);
	assert.match(makefile, /^hooks-check:$/m);
	assert.match(makefile, /core\.hooksPath/);
	assert.match(makefile, /\.githooks\/pre-push/);
	assert.match(makefile, /make all/);
	assert.match(prePush, /^make all$/m);
	assert.match(readme, /make hooks-install/);
	assert.match(readme, /make hooks-check/);
	assert.match(readme, /GitHub CI remains\s+authoritative/);
});

test("installation and startup do not silently mutate Git configuration", () => {
	const implicitHookScripts = Object.keys(packageJson.scripts ?? {}).filter((name) =>
		/^(pre|post)?(install|prepare)$/.test(name),
	);
	assert.deepEqual(implicitHookScripts, [], "install/prepare scripts must not install hooks implicitly");
	assert.doesNotMatch(readFileSync(resolve(root, "src/extension.ts"), "utf8"), /git config/);
});
