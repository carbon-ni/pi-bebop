import { promises as fs } from "node:fs";
import path from "node:path";
import type { CliOutcome } from "../output.ts";

/**
 * TASK-0063: `home` handler — compact project state for the no-argument
 * invocation. Pure IO read (one stat), deterministic output, zero network.
 */

function homeExecutable(env: { HOME?: string }, argv1: string | undefined): string {
	if (!argv1) return "pi-bebop";
	return argv1.replace(env.HOME ?? "~", "~");
}

function redactHome(env: { HOME?: string }, value: string): string {
	const home = env.HOME;
	if (!home) return value;
	return value.replace(home, "~");
}

export async function runHomeCommand(
	cwd: string,
	env: { HOME?: string } = process.env,
	argv1: string | undefined = process.argv[1],
): Promise<CliOutcome> {
	const project = cwd;
	const scaffoldAbs = path.join(project, ".pi/bebop/crew.json");
	let scaffold: "missing" | "present" = "missing";
	try {
		await fs.stat(scaffoldAbs);
		scaffold = "present";
	} catch {
		scaffold = "missing";
	}
	return {
		kind: "result",
		result: {
			ok: true,
			target: "",
			status: "home",
			data: {
				executable: homeExecutable(env, argv1),
				purpose: "Pi Bebop crew coordination CLI",
				project: redactHome(env, project),
				scaffold,
				commands: ["send", "crew init"],
				...(scaffold === "missing"
					? { next: "pi-bebop crew init" }
					: { next: 'pi --crew-socket "$PWD/.pi/bebop/sockets/lead.sock"' }),
			},
		},
		format: "toon",
		full: false,
	};
}
