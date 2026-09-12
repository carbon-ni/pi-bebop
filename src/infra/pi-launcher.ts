import { spawn, type ChildProcess } from "node:child_process";

export interface PiLaunchRequest {
	readonly sessionFile: string;
	readonly cwd: string;
	readonly environment?: NodeJS.ProcessEnv;
}

export type PiLaunchResult =
	| { readonly ok: true; readonly exitCode: number | null }
	| { readonly ok: false; readonly code: "spawn-failed" | "cancelled"; readonly message: string };

export interface PiLauncher {
	readonly launch: (request: PiLaunchRequest) => Promise<PiLaunchResult>;
}

/** Pi session metadata must not leak from a shell launched inside another Pi. */
export function sanitizePiEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const sanitized = { ...environment };
	for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"])
		delete sanitized[key];
	return sanitized;
}

function waitForPi(child: ChildProcess): Promise<PiLaunchResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: PiLaunchResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		child.once("error", (error) =>
			finish({
				ok: false,
				code: "spawn-failed",
				message: error instanceof Error ? error.message : "Pi could not be started",
			}),
		);
		child.once("close", (exitCode, signal) => {
			if (signal === "SIGINT") {
				finish({ ok: false, code: "cancelled", message: "Pi resume was cancelled" });
				return;
			}
			finish({ ok: true, exitCode });
		});
	});
}

export function createPiLauncher(spawnProcess: typeof spawn = spawn): PiLauncher {
	return {
		launch: async ({ sessionFile, cwd, environment }) => {
			let child: ChildProcess;
			try {
				child = spawnProcess("pi", ["--session", sessionFile], {
					cwd,
					env: sanitizePiEnvironment(environment ?? process.env),
					stdio: "inherit",
				});
			} catch (error) {
				return {
					ok: false,
					code: "spawn-failed",
					message: error instanceof Error ? error.message : "Pi could not be started",
				};
			}
			return waitForPi(child);
		},
	};
}
