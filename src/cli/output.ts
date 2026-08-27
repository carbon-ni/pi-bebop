import { encode } from "@toon-format/toon";
import type { CliFormat } from "./arguments.ts";

export interface CliResult {
	readonly ok: boolean;
	readonly target: string;
	readonly status: string;
	readonly response?: string;
	readonly data?: unknown;
	readonly error?: { code: string; message: string };
	readonly turnIndex?: number;
}

/**
 * TASK-0063: renderable outcome produced by every command handler. Help is
 * raw deterministic bytes (zero IO); results carry their own format/full
 * flags so the single renderer boundary never needs command knowledge.
 */
export type CliOutcome =
	| { readonly kind: "result"; readonly result: CliResult; readonly format: CliFormat; readonly full: boolean }
	| { readonly kind: "help"; readonly text: string };

/**
 * The single renderer boundary: one output write per invocation. Exit codes
 * are derived here: usage 2, help 0, success 0, operational failure 1.
 */
export function writeOutcome(output: NodeJS.WritableStream, outcome: CliOutcome): number {
	if (outcome.kind === "help") {
		output.write(outcome.text);
		return 0;
	}
	output.write(`${renderCliResult(outcome.result, outcome.format, outcome.full)}\n`);
	if (outcome.result.status === "usage") return 2;
	return outcome.result.ok ? 0 : 1;
}

const MAX_RESPONSE = 2000;

function textProvenance(result: CliResult): string | undefined {
	if (result.status !== "created" && result.status !== "unchanged") return undefined;
	if (typeof result.data !== "object" || result.data === null) return undefined;
	const source = (result.data as { source?: unknown }).source;
	if (typeof source !== "object" || source === null) return undefined;
	const descriptor = source as { type?: unknown; location?: unknown; resolvedRef?: unknown };
	if ((descriptor.type !== "local" && descriptor.type !== "git") || typeof descriptor.location !== "string") {
		return undefined;
	}
	const resolved = typeof descriptor.resolvedRef === "string" ? ` (resolved ${descriptor.resolvedRef})` : "";
	return `Source: ${descriptor.type} ${descriptor.location}${resolved}`;
}

export function renderCliResult(result: CliResult, format: CliFormat, full: boolean): string {
	if (format === "text") {
		if (!result.ok) return result.error?.message ?? "Operation failed";
		if (result.status === "persisted") return result.response ?? "Message persisted";
		const response = result.response ?? (result.status === "accepted" ? "Message accepted" : "Message completed");
		const provenance = textProvenance(result);
		return provenance === undefined ? response : `${response}\n${provenance}`;
	}
	const output: Record<string, unknown> = { ...result };
	if (result.response !== undefined) {
		const response = full ? result.response : result.response.slice(0, MAX_RESPONSE);
		output.response = response;
		output.truncation = {
			truncated: response.length < result.response.length,
			originalChars: result.response.length,
			shownChars: response.length,
		};
	}
	return format === "json" ? JSON.stringify(output) : encode(output);
}
