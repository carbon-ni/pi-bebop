import { Command } from "commander";
import { buildCrewInitCommand } from "./crew-init.ts";
import { buildSendCommand } from "./send.ts";

/**
 * TASK-0057/0058: the declarative root command tree. The root defines the
 * public command vocabulary (`send`, `crew init`); the no-argument home policy
 * is handled by the application (compact project state, never full help).
 *
 * This module is the declarative tree owner. Adding membership commands
 * (0060..0067) registers new leaf modules through the registry, never by
 * editing this composition.
 */
export function buildRootCommand(): Command {
	const crew = new Command("crew").description("Crew commands");
	crew.addCommand(buildCrewInitCommand());
	return new Command("pi-bebop")
		.description("Pi Bebop crew coordination CLI")
		.addCommand(buildSendCommand())
		.addCommand(crew);
}
