import type { CliFormat } from "./support/arguments.ts";

/**
 * Single executable audience/default policy. Every command defaults to the
 * concise human view; leaf builders and readers must not carry their own
 * literal fallback. --format controls successful result data only; guidance
 * and failures are plain text.
 */
export function defaultFormatForCommand(_command: string): CliFormat {
	return "text";
}
