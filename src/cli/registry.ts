import { Command } from "commander";
import { buildCrewInitCommand } from "./commands/crew-init.ts";
import { buildRootCommand } from "./commands/root.ts";
import { buildSendCommand } from "./commands/send.ts";
import { crewInitHelp } from "../domain/index.ts";
import { sendHelp } from "./commands/send.ts";
import { runHomeCommand } from "./commands/home-handler.ts";
import { runCrewInitCommand } from "./commands/crew-init-handler.ts";
import { runSendCommand } from "./commands/send-handler.ts";
import {
	UsageError,
	type CliCommand,
	type CrewInitCliOptions,
	type HomeCliOptions,
	type SendCliOptions,
} from "./arguments.ts";
import type { CliContext } from "./context.ts";
import type { CliOutcome } from "./output.ts";

/**
 * TASK-0063: the single owned CLI composition point (PO sequencing review).
 *
 * Every command is one leaf module owning metadata/schema (build), help, and
 * a handler adapter (run). The registry composes those leaves; central
 * protocol/dispatch/parser files are never extended directly by a slice.
 *
 * Parallel-slice merge protocol (TASK-0061 owner): membership slices
 * (0061..0067) add ONE leaf module plus ONE entry in `leaves` (and the
 * corresponding command in the parse facade's typed union in arguments.ts).
 * Existing handler modules and the root dispatch (an indexed leaf lookup in
 * run.ts) are never edited. Registry-only edits are owned by the TASK-0061
 * integration owner to keep the union, parser, and leaf map in lockstep.
 */

/** A leaf command: isolated metadata/help/handler modules composed by the registry. */
export interface CliLeaf<TOptions extends { command: string } = { command: string }> {
	/** Stable leaf id; must equal the parsed command's `command` discriminator. */
	readonly id: TOptions["command"];
	/** Deterministic, zero-IO help text for this leaf. */
	readonly help: () => string;
	/** Handler adapter — owns this command's business logic. */
	readonly run: (options: TOptions, context: CliContext) => Promise<CliOutcome>;
}

/**
 * Exhaustive leaf map over the typed command union. Adding a command to
 * `CliCommand` is a compile error here until a leaf is registered — the
 * registry is the only place command→handler wiring grows.
 */
export type CliLeafMap = {
	readonly [K in CliCommand["command"]]: CliLeaf<Extract<CliCommand, { command: K }>>;
};

export interface CliRegistry {
	/** Declarative `crew init` leaf schema (single flag definition). */
	readonly crewInit: () => Command;
	/** Declarative `send` leaf schema (single flag definition, TASK-0058). */
	readonly send: () => Command;
	/** The declarative root tree (`pi-bebop send`, `pi-bebop crew init`). */
	readonly root: () => Command;
	/** Exhaustive typed leaf composition (metadata/help/handler). */
	readonly leaves: CliLeafMap;
}

export function createCliRegistry(): CliRegistry {
	return {
		crewInit: () => buildCrewInitCommand(),
		send: () => buildSendCommand(),
		root: () => buildRootCommand(),
		leaves: {
			home: {
				id: "home",
				help: () => "",
				run: (_options, context) => runHomeCommand(context.cwd),
			},
			"crew-init": {
				id: "crew-init",
				help: () => crewInitHelp(),
				run: (options, context) => runCrewInitCommand(options, context.cwd),
			},
			send: {
				id: "send",
				help: () => sendHelp(),
				run: (options, context) => runSendCommand(options, context),
			},
		},
	};
}

/**
 * Generic ordered leaf composition primitive (extension seam). Pure and
 * stateless: every call builds a fresh lookup over the given leaves, so
 * composing the same leaves twice yields independent, equivalent tables.
 * Synthetic-leaf contract tests prove deterministic help/dispatch/error
 * behavior here; membership slices integrate through this shape.
 */
export interface LeafTable {
	/** Leaf ids in registration order. */
	readonly ids: readonly string[];
	readonly help: (id: string) => string;
	readonly dispatch: (options: { command: string }, context: CliContext) => Promise<CliOutcome>;
}

export function composeLeafTable(leaves: readonly CliLeaf[]): LeafTable {
	const byId = new Map(leaves.map((leaf) => [leaf.id, leaf] as const));
	return {
		ids: leaves.map((leaf) => leaf.id),
		help: (id) => {
			const leaf = byId.get(id);
			if (leaf === undefined) throw new UsageError(`Unknown command '${id}'`);
			return leaf.help();
		},
		dispatch: async (options, context) => {
			const leaf = byId.get(options.command);
			if (leaf === undefined) throw new UsageError(`Invalid command '${options.command}'; no handler registered`);
			return leaf.run(options, context);
		},
	};
}

// Re-exported for leaf modules that need the handler contract types.
export type { CliContext, CliOutcome };
