import { createCliRegistry } from "./registry.ts";
import { createCliExecutionAdapter } from "./execution-adapter.ts";
import { UsageError } from "./support/arguments.ts";
import { usageResult } from "./support/errors.ts";
import { cliFormatForArgs } from "./audience-policy.ts";
import { writeOutcome } from "./support/output.ts";
import type { Readable, Writable } from "node:stream";

/**
 * TASK-0063/TASK-0166: the CLI runner owns injected streams and the single
 * render boundary. Commander tree construction, parsing, and leaf dispatch
 * live in execution-adapter.ts; leaf parsers remain migration adapters until
 * TASK-0167/0168.
 */
export async function runCli(
	args: string[],
	cwd = process.cwd(),
	input: Readable = process.stdin,
	output: Writable = process.stdout,
	stderr: Writable = process.stderr,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const registry = createCliRegistry();
	const adapter = createCliExecutionAdapter(registry);
	const controller = new AbortController();
	const abortError = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
	const abort = () => controller.abort(abortError);
	process.once("SIGINT", abort);
	try {
		const outcome = await adapter.execute({
			args,
			cwd,
			input,
			output,
			stderr,
			environment,
			signal: controller.signal,
		});
		return writeOutcome(output, outcome);
	} catch (error) {
		if (error instanceof UsageError) {
			return writeOutcome(output, {
				kind: "result",
				result: usageResult(error.message),
				format: cliFormatForArgs(args),
				full: false,
			});
		}
		throw error;
	} finally {
		process.removeListener("SIGINT", abort);
	}
}
