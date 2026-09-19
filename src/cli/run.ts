import { createCliRegistry } from "./registry.ts";
import { createCliExecutionAdapter } from "./execution-adapter.ts";
import { UsageError } from "./support/arguments.ts";
import { writeOutcome } from "./support/output.ts";
import type { Readable, Writable } from "node:stream";

/**
 * TASK-0209: the CLI runner owns injected streams, cancellation, and the
 * single render boundary. Commander owns grammar, discovery, help, and
 * syntax errors (see execution-adapter.ts). Stream/exit contract:
 * help and successful results -> stdout; usage failures -> stderr, exit 2;
 * operational failures -> plain message on stderr, exit 1.
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
		return writeOutcome(output, stderr, outcome);
	} catch (error) {
		if (error instanceof UsageError) {
			const text = error.message.endsWith("\n") ? error.message : `${error.message}\n`;
			stderr.write(text);
			return 2;
		}
		stderr.write(`${error instanceof Error ? error.message : "CLI failure"}\n`);
		return 1;
	} finally {
		process.removeListener("SIGINT", abort);
	}
}
