#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "./run.ts";

// Re-exported so the existing characterization/integration suites keep
// importing the same public surface from "./main.ts".
export { runCli } from "./run.ts";
export { errorCode } from "./errors.ts";

/**
 * TASK-0063: composition root only. Owns the real process streams, the
 * environment, signals (delegated to runCli's single SIGINT install), the
 * adapter wiring, and exit assignment. All parsing, dispatch, rendering, and
 * command logic lives in run.ts / handlers / shared adapters.
 *
 * TASK-0074: npm install/link invoke the CLI through the `node_modules/.bin`
 * shim, so `process.argv[1]` is the symlink path, not the resolved module.
 * The guard therefore canonicalizes BOTH the invoked executable and the
 * executing module (realpath follows symlinks) and requires them to resolve
 * to the exact same packaged `dist/cli/main.js`. It never uses a basename- or
 * equality-only check: importing `src/cli/main.ts` (canonically equal to its
 * own module) must never start the CLI, and a symlink to any other file must
 * never pass. Any resolution failure (missing file, non-file URL) is safely
 * treated as "not the CLI entrypoint".
 */
export function isCliEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
	if (typeof argv1 !== "string" || argv1.length === 0) return false;
	try {
		const invoked = realpathSync(argv1);
		const modulePath = realpathSync(fileURLToPath(moduleUrl));
		const normalized = modulePath.replaceAll("\\", "/");
		return invoked === modulePath && normalized.endsWith("/dist/cli/main.js");
	} catch {
		return false;
	}
}

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
	runCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(`${error instanceof Error ? error.message : "CLI failure"}\n`);
			process.exitCode = 1;
		});
}
