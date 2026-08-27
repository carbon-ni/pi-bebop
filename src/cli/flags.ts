import { UsageError } from "./arguments.ts";

export interface FlagTokenSpec {
	/** Flags that accept one value and must not be repeated. */
	readonly valueFlags: ReadonlySet<string>;
	/** Boolean flags that must not be repeated. */
	readonly booleanFlags?: ReadonlySet<string>;
	/** Repeatable value flags extracted from Commander tokens. */
	readonly repeatableFlags?: ReadonlySet<string>;
	/** Repeatable flags whose value may be supplied after a `--` sentinel. */
	readonly escapedValueFlags?: ReadonlySet<string>;
	/** Whether a separated value beginning with `--` is treated as missing. */
	readonly rejectFlagLikeValues?: boolean;
}

export interface FlagTokenResult {
	readonly tokens: string[];
	readonly help: boolean;
	readonly seen: Set<string>;
	readonly repeatableValues: ReadonlyMap<string, string[]>;
}

/**
 * App-owned mechanical flag pass. Commander remains responsible for option
 * tokenization and command-specific errors; this owns shared duplicate/help,
 * equals syntax, repeatable extraction, and the value `--` escape.
 */
export function parseFlagTokens(args: readonly string[], spec: FlagTokenSpec): FlagTokenResult {
	const tokens: string[] = [];
	const seen = new Set<string>();
	const repeatableValues = new Map<string, string[]>();
	let help = false;
	for (let index = 0; index < args.length; index += 1) {
		const raw = args[index]!;
		const equals = raw.indexOf("=");
		const flag = equals > 0 ? raw.slice(0, equals) : raw;
		if (flag === "--help") {
			if (help) throw new UsageError("Duplicate flag: --help");
			help = true;
			continue;
		}
		if (spec.repeatableFlags?.has(flag)) {
			const extracted = readRepeatableValue(args, index, raw, equals, flag, spec);
			index = extracted.nextIndex;
			const values = repeatableValues.get(flag) ?? [];
			values.push(extracted.value);
			repeatableValues.set(flag, values);
			continue;
		}
		if (!spec.valueFlags.has(flag) && !spec.booleanFlags?.has(flag)) {
			tokens.push(raw);
			continue;
		}
		if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
		seen.add(flag);
		if (spec.booleanFlags?.has(flag) || equals > 0) {
			tokens.push(raw);
			continue;
		}
		const escaped = readEscapedValue(args, index, flag, spec);
		if (escaped !== undefined) {
			tokens.push(`${flag}=${escaped.value}`);
			index = escaped.nextIndex;
			continue;
		}
		tokens.push(raw);
	}
	return { tokens, help, seen, repeatableValues };
}

function readEscapedValue(
	args: readonly string[],
	index: number,
	flag: string,
	spec: FlagTokenSpec,
): { value: string; nextIndex: number } | undefined {
	if (!spec.escapedValueFlags?.has(flag)) return undefined;
	if (args[index + 1] !== "--" || args[index + 2] === undefined) return undefined;
	return { value: args[index + 2]!, nextIndex: index + 2 };
}

function readRepeatableValue(
	args: readonly string[],
	index: number,
	raw: string,
	equals: number,
	flag: string,
	spec: FlagTokenSpec,
): { value: string; nextIndex: number } {
	if (equals > 0) return { value: raw.slice(equals + 1), nextIndex: index };
	const escaped = readEscapedValue(args, index, flag, spec);
	if (escaped !== undefined) return escaped;
	const value = args[index + 1];
	if (value === undefined || (spec.rejectFlagLikeValues !== false && value.startsWith("--")))
		throw new UsageError(`Missing value for ${flag}`);
	return { value, nextIndex: index + 1 };
}
