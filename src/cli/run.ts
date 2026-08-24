import { parseCliCommand } from "./parser.ts";
import { UsageError, type CliCommand } from "./arguments.ts";
import { createCliRegistry, type CliLeaf } from "./registry.ts";
import { requestedFormat, usageResult } from "./errors.ts";
import { writeOutcome } from "./output.ts";
import type { CliContext } from "./context.ts";
import type { Readable, Writable } from "node:stream";

/**
 * TASK-0063: CLI runner — parse, dispatch, and the single render boundary.
 * No command business logic lives here: dispatch is an indexed lookup into
 * the exhaustive typed leaf map (registry), and every path writes output
 * exactly once through writeOutcome. SIGINT is installed once before dispatch
 * and removed on every terminal path.
 */
export async function runCli(
	args: string[],
	cwd = process.cwd(),
	input: Readable = process.stdin,
	output: Writable = process.stdout,
): Promise<number> {
	let options: CliCommand;
	try {
		options = parseCliCommand(args, cwd);
	} catch (error) {
		return writeOutcome(output, {
			kind: "result",
			result: usageResult((error as UsageError).message),
			format: requestedFormat(args),
			full: false,
		});
	}

	const registry = createCliRegistry();
	const controller = new AbortController();
	const abortError = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
	const abort = () => controller.abort(abortError);
	process.once("SIGINT", abort);
	try {
		const context: CliContext = { cwd, input, signal: controller.signal };
		// The leaf map is exhaustive over the typed command union by
		// construction; the cast is the correlated-union bridge for the
		// indexed lookup (adding a union member is a compile error until a
		// leaf is registered).
		const leaf = registry.leaves[options.command] as CliLeaf<CliCommand>;
		const outcome = await leaf.run(options, context);
		return writeOutcome(output, outcome);
	} catch (error) {
		if (error instanceof UsageError) {
			const format = "format" in options ? options.format : requestedFormat(args);
			return writeOutcome(output, {
				kind: "result",
				result: usageResult(error.message),
				format,
				full: false,
			});
		}
		throw error;
	} finally {
		process.removeListener("SIGINT", abort);
	}
}
