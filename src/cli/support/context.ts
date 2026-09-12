import type { Readable, Writable } from "node:stream";

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
	/** Optional process environment seam for deterministic execution adapters. */
	readonly environment?: NodeJS.ProcessEnv;
	/** Output stream for interactive command-owned UI, when needed. */
	readonly output?: Writable;
}
