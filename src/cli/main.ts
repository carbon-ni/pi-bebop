#!/usr/bin/env node
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
 */
export function isCliEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
	return (
		Boolean(argv1?.replaceAll("\\\\", "/").endsWith("/dist/cli/main.js")) && moduleUrl.endsWith("/dist/cli/main.js")
	);
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
