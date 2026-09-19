import type { CliFormat } from "./support/arguments.ts";

/**
 * Single executable audience/default policy. Every command's default format
 * is declared here — leaf builders and readers must not carry their own
 * literal fallback. --format controls successful result data only; guidance
 * and failures are plain text.
 */
const HUMAN_FIRST_COMMANDS = new Set(["crew-init"]);

/** Declared per-command default: human-first commands default to text, the rest to TOON. */
export function defaultFormatForCommand(command: string): CliFormat {
	return HUMAN_FIRST_COMMANDS.has(command) ? "text" : "toon";
}
