import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { RoleSessionCandidate } from "../../application/role-session-resume.ts";

export type RoleSessionPickerResult =
	| { readonly kind: "selected"; readonly candidate: RoleSessionCandidate }
	| { readonly kind: "cancelled" }
	| { readonly kind: "empty" };

function candidateLabel(candidate: RoleSessionCandidate): string {
	return `${candidate.name ?? candidate.sessionId} — ${candidate.modified}`;
}

/** A small Bebop-owned picker; it never delegates selection to Pi's unfiltered picker. */
export async function pickRoleSession(
	candidates: readonly RoleSessionCandidate[],
	input: Readable,
	output: Writable,
	signal?: AbortSignal,
): Promise<RoleSessionPickerResult> {
	if (candidates.length === 0) return { kind: "empty" };
	const lines = candidates.map((candidate, index) => `${index + 1}) ${candidateLabel(candidate)}`);
	output.write(`${lines.join("\n")}\n`);
	const readline = createInterface({ input, output });
	try {
		const answer = (await readline.question("Select a session (number, or q to cancel): ", { signal })).trim();
		if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit" || answer === "")
			return { kind: "cancelled" };
		if (!/^\d+$/.test(answer)) return { kind: "cancelled" };
		const index = Number(answer) - 1;
		if (!Number.isSafeInteger(index) || index < 0 || index >= candidates.length) return { kind: "cancelled" };
		return { kind: "selected", candidate: candidates[index]! };
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return { kind: "cancelled" };
		return { kind: "cancelled" };
	} finally {
		readline.close();
	}
}
