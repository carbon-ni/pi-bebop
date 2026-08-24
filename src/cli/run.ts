import { createCliRegistry } from "./registry.ts";
import { UsageError, type CliFormat } from "./arguments.ts";
import { requestedFormat, usageResult } from "./errors.ts";
import { writeOutcome } from "./output.ts";
import type { CliContext } from "./context.ts";
import type { Readable, Writable } from "node:stream";

/**
 * TASK-0063: CLI runner — parse, dispatch, and the single render boundary.
 * No command business logic lives here: vocabulary, parsing, help, the root
 * tree, and dispatch all derive from the ordered registry leaf composition
 * (see registry.ts), and every path writes output exactly once through
 * writeOutcome. SIGINT is installed once before dispatch and removed on every
 * terminal path.
 */

function parsedFormat(options: { format?: CliFormat } | null | undefined, args: string[]): CliFormat {
	return options && typeof options.format === "string" ? options.format : requestedFormat(args);
}

export async function runCli(
	args: string[],
	cwd = process.cwd(),
	input: Readable = process.stdin,
	output: Writable = process.stdout,
): Promise<number> {
	const registry = createCliRegistry();
	let options: { command: string } | undefined;
	try {
		options = registry.parseCliCommand(args, cwd) as { command: string };
	} catch (error) {
		return writeOutcome(output, {
			kind: "result",
			result: usageResult((error as UsageError).message),
			format: requestedFormat(args),
			full: false,
		});
	}

	const controller = new AbortController();
	const abortError = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
	const abort = () => controller.abort(abortError);
	process.once("SIGINT", abort);
	try {
		const context: CliContext = { cwd, input, signal: controller.signal };
		// Dispatch derives from the registry: the leaf id equals the parsed
		// command discriminator, and the leaf owns run.
		const leaf = registry.leafById(options.command);
		const outcome = await leaf.run(options, context);
		return writeOutcome(output, outcome);
	} catch (error) {
		if (error instanceof UsageError) {
			return writeOutcome(output, {
				kind: "result",
				result: usageResult(error.message),
				format: parsedFormat(options as { format?: CliFormat } | null | undefined, args),
				full: false,
			});
		}
		throw error;
	} finally {
		process.removeListener("SIGINT", abort);
	}
}
