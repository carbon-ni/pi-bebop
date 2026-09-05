import { UsageError } from "./arguments.ts";

export interface CliFlagSpec {
	readonly name: string;
	readonly kind: "value" | "boolean" | "repeatable";
	readonly allowSentinelValue?: boolean;
	readonly missingValueMessage?: string;
	readonly maxValues?: number;
	readonly tooManyValuesMessage?: string;
}

export interface ScannedCliFlags {
	readonly tokens: string[];
	readonly help: boolean;
	readonly seen: ReadonlySet<string>;
	readonly repeatedValues: Readonly<Record<string, readonly string[]>>;
}

/**
 * Performs the shared pre-pass used by Commander-backed command parsers.
 * Unknown tokens remain untouched for Commander to diagnose; this primitive
 * owns only duplicate/help handling and the two supported value forms.
 */
export function scanCliFlags(args: readonly string[], specs: readonly CliFlagSpec[]): ScannedCliFlags {
	const byName = new Map(specs.map((spec) => [spec.name, spec]));
	const seen = new Set<string>();
	const repeatedValues: Record<string, string[]> = {};
	const tokens: string[] = [];
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
		const spec = byName.get(flag);
		if (!spec) {
			tokens.push(raw);
			continue;
		}
		if (spec.kind !== "repeatable" && seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
		if (spec.kind !== "repeatable") seen.add(flag);
		if (spec.kind === "boolean") {
			tokens.push(raw);
			continue;
		}
		if (spec.kind === "repeatable") {
			const value = readValue(args, index, raw, spec);
			index = value.nextIndex;
			const values = (repeatedValues[flag] ??= []);
			values.push(value.value);
			if (spec.maxValues !== undefined && values.length > spec.maxValues)
				throw new UsageError(spec.tooManyValuesMessage ?? `Too many values for ${flag}`);
			continue;
		}
		if (equals > 0 || (spec.allowSentinelValue && args[index + 1] === "--" && args[index + 2] !== undefined)) {
			if (spec.allowSentinelValue && equals < 0) {
				tokens.push(`${flag}=${args[index + 2]}`);
				index += 2;
			} else tokens.push(raw);
			continue;
		}
		tokens.push(raw);
	}
	return { tokens, help, seen, repeatedValues };
}

function readValue(
	args: readonly string[],
	index: number,
	raw: string,
	spec: CliFlagSpec,
): { value: string; nextIndex: number } {
	const equals = raw.indexOf("=");
	if (equals > 0) return { value: raw.slice(equals + 1), nextIndex: index };
	if (spec.allowSentinelValue && args[index + 1] === "--" && args[index + 2] !== undefined)
		return { value: args[index + 2]!, nextIndex: index + 2 };
	const value = args[index + 1];
	if (value === undefined || (value.startsWith("--") && !spec.allowSentinelValue))
		throw new UsageError(spec.missingValueMessage ?? `Missing value for ${spec.name}`);
	if (value.startsWith("--") && spec.allowSentinelValue)
		throw new UsageError(spec.missingValueMessage ?? `Missing value for ${spec.name}`);
	return { value, nextIndex: index + 1 };
}
