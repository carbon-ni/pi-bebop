import { UsageError } from "./arguments.ts";
import type { Readable } from "node:stream";

/**
 * TASK-0063: injected, bounded, cancellable stdin reading. The stream is
 * injected (never process.stdin directly), reads are cancellable through the
 * abort signal (SIGINT), and the message is bounded in UTF-8 bytes so a
 * runaway pipe cannot pin the CLI forever. Empty input stays a caller-side
 * usage decision — this reader resolves with "" and the handler rejects it.
 */
export const MAX_STDIN_BYTES = 1_000_000;

/**
 * Reads the entire injected stdin stream as UTF-8 text.
 *
 * Resolves with the exact bytes on `end`; rejects with the stream error on
 * `error`; rejects with the signal reason on abort (after destroying the
 * input so a held-open pipe cannot keep the process alive); rejects with a
 * UsageError once the accumulated bytes exceed `maxBytes`.
 */
export function readStdinMessage(input: Readable, signal: AbortSignal, maxBytes = MAX_STDIN_BYTES): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		const cleanup = () => {
			input.off("data", onData);
			input.off("end", onEnd);
			input.off("error", onError);
			signal.removeEventListener("abort", onAbort);
		};
		const onData = (chunk: string) => {
			data += chunk;
			if (Buffer.byteLength(data, "utf8") > maxBytes) {
				cleanup();
				input.pause();
				input.destroy();
				reject(new UsageError(`--stdin exceeds the ${maxBytes}-byte message limit`));
			}
		};
		const onEnd = () => {
			cleanup();
			resolve(data);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			cleanup();
			input.pause();
			input.destroy();
			reject(
				signal.reason instanceof Error
					? signal.reason
					: Object.assign(new Error("Operation aborted"), { name: "AbortError" }),
			);
		};
		input.setEncoding("utf8");
		input.on("data", onData);
		input.once("end", onEnd);
		input.once("error", onError);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
