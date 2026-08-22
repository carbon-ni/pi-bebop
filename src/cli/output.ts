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

const MAX_RESPONSE = 2000;

export function renderCliResult(result: CliResult, format: CliFormat, full: boolean): string {
	if (format === "text") {
		if (!result.ok) return result.error?.message ?? "Operation failed";
		return result.response ?? (result.status === "accepted" ? "Message accepted" : "Message completed");
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
