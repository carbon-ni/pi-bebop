import { execFile as nodeExecFile } from "node:child_process";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const FALLBACK_INTERVAL_MS = 60_000;

type Watcher = Pick<FSWatcher, "on" | "close">;
type Listener = (event: string, filename: string | Buffer | null) => void;

interface Dependencies {
	findGitDir: () => Promise<string | null>;
	watch: (directory: string, listener: Listener) => Watcher;
	fallback: (callback: () => void, delayMs: number) => () => void;
}

const defaults: Dependencies = {
	async findGitDir() {
		try {
			const { stdout } = await execFile("git", ["rev-parse", "--absolute-git-dir"], { cwd: process.cwd() });
			return stdout.trim() || null;
		} catch {
			return null;
		}
	},
	watch: (directory, listener) => fsWatch(directory, listener),
	fallback: (callback, delayMs) => {
		const timer = setInterval(callback, delayMs);
		timer.unref();
		return () => clearInterval(timer);
	},
};

/** Observe checkout changes without running Git on every idle tick. */
export async function watchGitHead(onChange: () => void, deps: Dependencies = defaults): Promise<() => void> {
	let watcher: Watcher | undefined;
	let stopFallback: (() => void) | undefined;
	let stopped = false;
	const startFallback = () => {
		if (!stopped && !stopFallback) stopFallback = deps.fallback(onChange, FALLBACK_INTERVAL_MS);
	};

	const gitDir = await deps.findGitDir();
	if (gitDir) {
		try {
			watcher = deps.watch(gitDir, (_event, filename) => {
				if (!stopped && (filename === null || filename.toString() === "HEAD")) onChange();
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
				startFallback();
			});
		} catch {
			startFallback();
		}
	} else {
		startFallback();
	}

	return () => {
		stopped = true;
		watcher?.close();
		stopFallback?.();
	};
}
