import type { Readable } from "node:stream";

/**
 * TASK-0063: shared handler context. Handlers receive injected streams, the
 * working directory, and the cancellation signal instead of touching real
 * process state, keeping them deterministic and testable.
 */
export interface CliContext {
	/** Working directory used for path resolution and manifest discovery. */
	readonly cwd: string;
	/** Injected stdin; used only when a command reads message input. */
	readonly input: Readable;
	/** Cancellation signal (SIGINT); aborts stdin reads and RPC waits. */
	readonly signal: AbortSignal;
}
