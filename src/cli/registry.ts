import { Command } from "commander";
import { buildCrewInitCommand } from "./commands/crew-init.ts";
import { buildRootCommand } from "./commands/root.ts";

/**
 * TASK-0057: the single owned command registry (PO sequencing review).
 *
 * The registry is the only module that composes the command tree from
 * per-action modules. Central protocol/dispatch/parser files are never extended
 * directly by a slice; downstream tasks (0060..0067) add a per-action module
 * and register it here.
 */
export interface CliRegistry {
	/** The declarative `crew init` leaf schema (single flag definition). */
	readonly crewInit: () => Command;
	/** The declarative root tree (`pi-bebop crew init`). */
	readonly root: () => Command;
}

export function createCliRegistry(): CliRegistry {
	return {
		crewInit: () => buildCrewInitCommand(),
		root: () => buildRootCommand(),
	};
}
