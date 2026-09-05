import { UsageError } from "./arguments.ts";

/** Shared positive-duration grammar for timeout-style options (500ms, 30s, 5m). */
export function parsePositiveDurationMs(value: string): number {
	const match = /^(\d+)(ms|s|m)$/.exec(value);
	if (!match || Number(match[1]) < 1)
		throw new UsageError(`Invalid --timeout '${value}'; use a positive duration such as 500ms, 30s, or 5m`);
	const multiplier = match[2] === "m" ? 60000 : match[2] === "s" ? 1000 : 1;
	const result = Number(match[1]) * multiplier;
	if (!Number.isSafeInteger(result)) throw new UsageError(`Invalid --timeout '${value}'; duration is too large`);
	return result;
}
