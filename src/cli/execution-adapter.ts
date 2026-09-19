import { CommanderError, type Command } from "commander";
import type { Readable, Writable } from "node:stream";
import { buildRootCommand, type CliLeaf, type CliRegistry } from "./registry.ts";
import type { CliContext } from "./support/context.ts";
import type { CliOutcome } from "./support/output.ts";
import { UsageError } from "./support/arguments.ts";
import { cliVersionOutput } from "./version.ts";

export type CliExecutionResult = CliOutcome;

export interface CliExecutionRequest {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly input: Readable;
	readonly output: Writable;
	readonly stderr?: Writable;
	readonly environment?: NodeJS.ProcessEnv;
	readonly signal: AbortSignal;
}

/**
 * TASK-0209: the sole production Commander execution boundary. Commander
 * owns command discovery, help (`-h`/`--help`/`help [command]`), version,
 * syntax validation, suggestions, and the error presentation; this adapter
 * only wires leaf actions, captures Commander's stream writes into outcome
 * values, and maps exit classes (help 0/stdout, usage 2/stderr).
 */
export function createCliExecutionAdapter(registry: CliRegistry) {
	let invocation: { request: CliExecutionRequest } | undefined;
	let dispatched: CliExecutionResult | undefined;
	let helpOut = "";
	let capturedErr = "";

	const attachLeafAction = (command: Command, leaf: CliLeaf) => {
		command.action(async () => {
			if (invocation === undefined) throw new UsageError("CLI execution was not initialized");
			const { request } = invocation;
			const options = leaf.read(command, request.cwd);
			const context: CliContext = {
				cwd: request.cwd,
				input: request.input,
				signal: request.signal,
				environment: request.environment,
				output: request.output,
			};
			dispatched = await leaf.run(options, context);
		});
	};

	// The root is configured before leaves attach: Commander descendants
	// inherit the output configuration at creation time, so capture must be
	// installed first or help/errors would reach the process streams directly.
	const program = buildRootCommand(registry.leaves, {
		onRoot: (root) => {
			root.version(cliVersionOutput(), "-v, --version", "Display version");
			root.showHelpAfterError(true); // syntax failures show the addressed command's local usage
			root.exitOverride().configureOutput({
				writeOut: (text) => {
					helpOut += text;
				},
				writeErr: (text) => {
					capturedErr += text;
				},
				getOutHasColors: () => false,
				getErrHasColors: () => false,
			});
		},
		onLeaf: attachLeafAction,
	});

	return {
		async execute(request: CliExecutionRequest): Promise<CliExecutionResult> {
			invocation = { request };
			dispatched = undefined;
			helpOut = "";
			capturedErr = "";
			try {
				await program.parseAsync(["node", "pi-bebop", ...request.args]);
			} catch (error) {
				if (error instanceof CommanderError) {
					// Explicit help (-h/--help) and version: Commander wrote the
					// text to stdout before exiting.
					if (error.code === "commander.helpDisplayed" || error.code === "commander.version")
						return { kind: "help", text: helpOut };
					// No arguments and bare groups: Commander writes the local help
					// to stderr with exit 1; the contract promotes it to stdout/exit 0.
					if (error.code === "commander.help")
						return { kind: "help", text: helpOut.length > 0 ? helpOut : capturedErr };
					// Syntax failures carry Commander's message plus the addressed
					// command's local usage — presented verbatim as a usage failure.
					throw new UsageError((capturedErr.length > 0 ? capturedErr : error.message).trimEnd());
				}
				throw error;
			}
			if (dispatched !== undefined) return dispatched;
			throw new UsageError("No command provided");
		},
	};
}
