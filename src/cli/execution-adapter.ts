import { Command, CommanderError } from "commander";
import type { Readable, Writable } from "node:stream";
import { UsageError } from "./support/arguments.ts";
import { buildRootCommand, type CliLeaf, type CliRegistry } from "./registry.ts";
import type { CliContext } from "./support/context.ts";
import type { CliOutcome } from "./support/output.ts";
import { rootCliHelp } from "./root-help.ts";
import { cliVersionOutput } from "./version.ts";

export interface CliExecutionRequest {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly input: Readable;
	readonly output: Writable;
	readonly stderr?: Writable;
	readonly environment?: NodeJS.ProcessEnv;
	readonly signal: AbortSignal;
}

export type CliExecutionResult = CliOutcome;

interface Invocation {
	readonly request: CliExecutionRequest;
	readonly program: Command;
}

function longOptionNames(program: Command): Set<string> {
	const names = new Set<string>();
	const visit = (command: Command) => {
		for (const option of command.options) if (option.long !== undefined) names.add(option.long);
		for (const child of command.commands) visit(child);
	};
	visit(program);
	return names;
}

/**
 * Commander retains the last scalar option. Keep the compatibility contract by
 * rejecting repeated scalar options once, before Commander or a leaf handler
 * can observe them. Repeatable instructions are the one intentional exception.
 */
export function rejectDuplicateScalarOptions(args: readonly string[], program: Command): void {
	const scalarOptions = longOptionNames(program);
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index]!;
		if (token === "--") break;
		if (!token.startsWith("--")) continue;
		const name = token.slice(0, token.indexOf("=") === -1 ? token.length : token.indexOf("="));
		if (name === "--instruction" || !scalarOptions.has(name)) continue;
		if (seen.has(name)) throw new UsageError(`Duplicate flag: ${name}`);
		seen.add(name);
	}
}

function normalizeLeafHelp(tokens: readonly string[]): string[] {
	let sentinel = false;
	return tokens.map((token) => {
		if (token === "--") sentinel = true;
		return !sentinel && token === "-h" ? "--help" : token;
	});
}

function mapCommanderError(error: CommanderError, args: readonly string[], vocabulary: readonly string[]): UsageError {
	if (error.code === "commander.unknownCommand")
		return new UsageError(`Invalid command '${args[0] ?? ""}'; valid commands: ${vocabulary.join(", ")}`);
	if (error.code === "commander.optionMissingArgument") {
		const match = /option '([^']+)' argument missing/.exec(error.message);
		throw new UsageError(`Missing value for ${match?.[1] ?? "option"}`);
	}
	if (error.code === "commander.unknownOption") return new UsageError(error.message);
	if (error.code === "commander.excessArguments") return new UsageError(error.message);
	return new UsageError(error.message);
}

function addHelpOption(command: Command, deferLeafSyntax = false): void {
	command
		.helpOption(false)
		.option("-h, --help", "Display help")
		.exitOverride()
		.configureOutput({
			writeOut: () => {},
			writeErr: () => {},
			outputError: () => {},
		});
	if (deferLeafSyntax) command.allowUnknownOption(true).allowExcessArguments(true);
}

function actionCommand(args: readonly unknown[]): Command | undefined {
	const candidate = args.at(-1);
	return candidate instanceof Command ? candidate : undefined;
}

/**
 * The sole production Commander execution boundary. Leaf parsers remain
 * migration adapters for 0167/0168; Commander owns tree selection, syntax,
 * help/version options, and asynchronous leaf action dispatch here.
 */
export function createCliExecutionAdapter(registry: CliRegistry) {
	let invocation: Invocation | undefined;
	let dispatched: CliExecutionResult | undefined;
	const leafHelp = new Map<Command, string>();
	const program = buildRootCommand(registry.leaves, {
		onGroup: (command) => {
			addHelpOption(command);
			command.action((...args: unknown[]) => {
				const selected = actionCommand(args) ?? command;
				dispatched = { kind: "help", text: selected.helpInformation() };
			});
		},
		onLeaf: (command, leaf) => {
			leafHelp.set(command, leaf.help());
			// TASK-0167: a leaf with a Commander reader owns its full option and
			// arity surface, so Commander enforces unknown options and excess
			// arguments strictly before the reader or handler runs. Legacy
			// parse-only leaves keep deferred syntax until their migration.
			const migrated = leaf.read !== undefined;
			addHelpOption(command, !migrated);
			if (!migrated) command.allowUnknownOption(true).allowExcessArguments(true);
			command.action(async () => {
				if (invocation === undefined) throw new UsageError("CLI execution was not initialized");
				const { request } = invocation;
				const prefixLength = leaf.names.length;
				const tokens = normalizeLeafHelp(request.args.slice(prefixLength));
				const options = leaf.read ? leaf.read(command, request.cwd) : leaf.parse(tokens, request.cwd);
				const context: CliContext = {
					cwd: request.cwd,
					input: request.input,
					signal: request.signal,
					environment: request.environment,
				};
				dispatched = await leaf.run(options, context);
			});
		},
	});
	addHelpOption(program);
	program.option("-v, --version", "Display version");
	program.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });

	return {
		async execute(request: CliExecutionRequest): Promise<CliExecutionResult> {
			invocation = { request, program };
			dispatched = undefined;
			const context: CliContext = {
				cwd: request.cwd,
				input: request.input,
				signal: request.signal,
				environment: request.environment,
			};
			if (request.args.length === 0) {
				const home = registry.leafById("home");
				return home.run(home.parse([], request.cwd), context);
			}
			if (request.args[0] === "-h" || request.args[0] === "--help")
				return { kind: "help", text: rootCliHelp(registry.vocabulary()) };
			if (request.args[0] === "-v" || request.args[0] === "--version") {
				return {
					kind: "result",
					result: { ok: true, target: "", status: "version", response: cliVersionOutput() },
					format: "text",
					full: false,
				};
			}
			try {
				const helpIndex = request.args.findIndex((token) => token === "--help" || token === "-h");
				if (helpIndex >= 0 && !request.args.slice(0, helpIndex).includes("--")) {
					let selected = program;
					for (const token of request.args.slice(0, helpIndex)) {
						const child = selected.commands.find((candidate) => candidate.name() === token);
						if (child === undefined) break;
						selected = child;
					}
					return { kind: "help", text: leafHelp.get(selected) ?? selected.helpInformation() };
				}
				rejectDuplicateScalarOptions(request.args, program);
				await program.parseAsync(["node", "pi-bebop", ...request.args]);
			} catch (error) {
				if (error instanceof CommanderError) {
					if (error.message === "(outputHelp)") {
						return { kind: "help", text: rootCliHelp(registry.vocabulary()) };
					}
					if (request.args[0]?.startsWith("-") && error.code === "commander.unknownOption")
						throw new UsageError(
							`Invalid command '${request.args[0]}'; valid commands: ${registry.vocabulary().join(", ")}`,
						);
					throw mapCommanderError(error, request.args, registry.vocabulary());
				}
				throw error;
			}
			if (dispatched !== undefined) return dispatched;
			if (program.opts().help === true) return { kind: "help", text: rootCliHelp(registry.vocabulary()) };
			throw new UsageError("No command provided");
		},
	};
}
