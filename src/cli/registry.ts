import { Command } from "commander";
import { buildCrewInitCommand } from "./commands/crew-init.ts";
import { buildSendCommand } from "./commands/send.ts";
import { parseCrewInitCommand, parseSendCommand } from "./parser.ts";
import { crewInitHelp } from "../domain/index.ts";
import { sendHelp } from "./commands/send.ts";
import { runHomeCommand } from "./commands/home-handler.ts";
import { runCrewInitCommand } from "./commands/crew-init-handler.ts";
import { runSendCommand } from "./commands/send-handler.ts";
import {
	parseMemberStatusCommand,
	runMemberStatusCommand,
	memberStatusHelp,
	buildMemberStatusCommand,
	type MemberStatusCliOptions,
} from "./commands/member-status.ts";
import {
	parseSessionListCommand,
	runSessionListCommand,
	sessionListHelp,
	buildSessionListCommand,
	type SessionListCliOptions,
} from "./commands/session-list.ts";
import { UsageError, type CrewInitCliOptions, type SendCliOptions } from "./arguments.ts";
import type { CliContext } from "./context.ts";
import type { CliOutcome } from "./output.ts";

/**
 * TASK-0063: the single owned CLI composition point (PO sequencing review,
 * QA blocker resolution).
 *
 * Every command is ONE leaf module owning its vocabulary (`names`), schema
 * metadata (`build`), help, parser (`parse`), and handler adapter (`run`).
 * `composeRegistry` derives everything else from the ordered leaf list:
 *
 * - parse vocabulary (parseCliCommand matches the longest leaf name prefix),
 * - command-tree metadata (root builds groups/leaves from leaf names),
 * - help (leafById(id).help()),
 * - dispatch (leafById(id).run(options, context)).
 *
 * Adding a membership leaf (TASK-0061..0067) is exactly ONE registry
 * contribution: append one leaf module to the `leaves` array. No parser,
 * root-tree, dispatch, or existing-handler edits are required. Registry-only
 * edits are owned by the TASK-0061 integration owner.
 */

export interface CliLeaf {
	/** Stable leaf id; also the parse/dispatch key. */
	readonly id: string;
	/** Command vocabulary words, e.g. ["send"] or ["crew", "init"]. Empty for the no-argument home state. */
	readonly names: readonly string[];
	/** Commander schema metadata for this leaf (tokenization + generated help). */
	readonly build: () => Command;
	/** Deterministic, zero-IO help text. */
	readonly help: () => string;
	/** Leaf-owned tokenization + semantic validation; receives tokens after `names`. */
	readonly parse: (tokens: readonly string[], cwd: string) => unknown;
	/** Handler adapter — owns this command's business logic. */
	readonly run: (options: unknown, context: CliContext) => Promise<CliOutcome>;
}

export interface ParsedCommand {
	readonly id: string;
	readonly options: unknown;
}

export interface CliRegistry {
	/** Ordered leaf composition — the only place command wiring grows. */
	readonly leaves: readonly CliLeaf[];
	/** Public command vocabulary in registry order (for help/home/usage errors). */
	readonly vocabulary: () => readonly string[];
	/**
	 * Registry-driven parse: longest leaf-name-prefix match, then leaf.parse.
	 * Returns the leaf's raw parsed options (the leaf id equals `.command`).
	 */
	readonly parseCliCommand: (args: readonly string[], cwd?: string) => unknown;
	readonly leafById: (id: string) => CliLeaf;
	/** Command tree derived from the ordered leaves (groups + leaves). */
	readonly root: () => Command;
}

function findOrCreate(parent: Command, name: string, description: string | undefined): Command {
	const existing = parent.commands.find((candidate) => candidate.name() === name);
	if (existing) return existing;
	const child = new Command(name);
	if (description !== undefined) child.description(description);
	parent.addCommand(child);
	return child;
}

const GROUP_DESCRIPTIONS: Record<string, string> = {
	crew: "Crew commands",
	member: "Member commands",
	session: "Session commands",
};

/** Builds the declarative root tree from the ordered leaves (no hardcoded vocabulary). */
export function buildRootCommand(leaves: readonly CliLeaf[]): Command {
	const root = new Command("pi-bebop").description("Pi Bebop crew coordination CLI");
	for (const leaf of leaves) {
		if (leaf.names.length === 0) continue; // home has no command word
		if (leaf.names.length === 1) {
			root.addCommand(leaf.build());
			continue;
		}
		let parent = root;
		for (const word of leaf.names.slice(0, -1)) {
			parent = findOrCreate(parent, word, GROUP_DESCRIPTIONS[word]);
		}
		parent.addCommand(leaf.build());
	}
	return root;
}

/**
 * Composes a full registry from an ordered leaf list. Pure and stateless:
 * every call builds fresh lookups, so composing the same leaves twice yields
 * independent, equivalent registries. The home leaf's run is wired to the
 * computed vocabulary so home output derives from the same registry order.
 */
export function composeRegistry(leaves: readonly CliLeaf[]): CliRegistry {
	const vocabulary = leaves.filter((leaf) => leaf.names.length > 0).map((leaf) => leaf.names.join(" "));
	const effectiveLeaves = leaves.map((leaf) =>
		leaf.id === "home"
			? {
					...leaf,
					run: (_options: unknown, context: CliContext) =>
						runHomeCommand(context.cwd, vocabulary, process.env, process.argv[1]),
				}
			: leaf,
	);
	const byId = new Map(effectiveLeaves.map((leaf) => [leaf.id, leaf] as const));
	return {
		leaves: effectiveLeaves,
		vocabulary: () => vocabulary,
		leafById: (id) => {
			const leaf = byId.get(id);
			if (leaf === undefined) throw new UsageError(`Unknown command '${id}'`);
			return leaf;
		},
		parseCliCommand: (args, cwd = process.cwd()) => {
			if (args.length === 0) {
				const home = byId.get("home");
				if (home === undefined) throw new UsageError("No command provided");
				return home.parse([], cwd);
			}
			let best: { leaf: CliLeaf; tokens: string[] } | undefined;
			for (const leaf of effectiveLeaves) {
				if (leaf.names.length === 0 || leaf.names.length > args.length) continue;
				let matches = true;
				for (let index = 0; index < leaf.names.length; index += 1) {
					if (leaf.names[index] !== args[index]) {
						matches = false;
						break;
					}
				}
				if (matches && (best === undefined || leaf.names.length > best.leaf.names.length)) {
					best = { leaf, tokens: args.slice(leaf.names.length) };
				}
			}
			if (best === undefined)
				throw new UsageError(`Invalid command '${args[0] ?? ""}'; valid commands: ${vocabulary.join(", ")}`);
			return best.leaf.parse(best.tokens, cwd);
		},
		root: () => buildRootCommand(effectiveLeaves),
	};
}

const homeLeaf: CliLeaf = {
	id: "home",
	names: [],
	build: () => new Command("home"), // never added to the root tree (no command word)
	help: () => "",
	parse: () => ({ command: "home" }),
	// Vocabulary is wired by composeRegistry; this base body is never used.
	run: (_options, context) => runHomeCommand(context.cwd, [], process.env, process.argv[1]),
};

const sendLeaf: CliLeaf = {
	id: "send",
	names: ["send"],
	build: () => buildSendCommand(),
	help: () => sendHelp(),
	parse: (tokens, cwd) => parseSendCommand([...tokens], cwd),
	run: (options, context) => runSendCommand(options as SendCliOptions, context),
};

const crewInitLeaf: CliLeaf = {
	id: "crew-init",
	names: ["crew", "init"],
	build: () => buildCrewInitCommand(),
	help: () => crewInitHelp(),
	parse: (tokens, cwd) => parseCrewInitCommand([...tokens], cwd),
	run: (options, context) => runCrewInitCommand(options as CrewInitCliOptions, context.cwd),
};

/** TASK-0061: `member status <member>` leaf — one registry contribution. */
const memberStatusLeaf: CliLeaf = {
	id: "member-status",
	names: ["member", "status"],
	build: () => buildMemberStatusCommand(),
	help: () => memberStatusHelp(),
	parse: (tokens, cwd) => parseMemberStatusCommand([...tokens], cwd),
	run: (options, context) => runMemberStatusCommand(options as MemberStatusCliOptions, context),
};

/** TASK-0061: `session list` leaf — one registry contribution. */
const sessionListLeaf: CliLeaf = {
	id: "session-list",
	names: ["session", "list"],
	build: () => buildSessionListCommand(),
	help: () => sessionListHelp(),
	parse: (tokens, cwd) => parseSessionListCommand([...tokens], cwd),
	run: (options, context) => runSessionListCommand(options as SessionListCliOptions, context),
};

export function createCliRegistry(): CliRegistry {
	return composeRegistry([homeLeaf, sendLeaf, crewInitLeaf, memberStatusLeaf, sessionListLeaf]);
}

/** Convenience: parse against the built-in registry (registry-driven vocabulary). */
export function parseCliCommand(args: readonly string[], cwd = process.cwd()): unknown {
	return createCliRegistry().parseCliCommand(args, cwd);
}
