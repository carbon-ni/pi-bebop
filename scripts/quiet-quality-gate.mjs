import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const QUALITY_COMMANDS = [
	["npm", ["run", "lint"]],
	["npm", ["test"]],
];

function runCommand(command, args) {
	return spawnSync(command, args, {
		cwd: process.cwd(),
		encoding: "utf8",
	});
}

function failureDetails(command, args, result) {
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	const reason = result.error?.message ?? (output || `exit status ${result.status ?? "unknown"}`);
	return `${command} ${args.join(" ")} failed\n${reason}\n`;
}

export function runQualityGate({
	commands = QUALITY_COMMANDS,
	run = runCommand,
	write = (text) => process.stdout.write(text),
	writeError = (text) => process.stderr.write(text),
} = {}) {
	for (const [command, args] of commands) {
		const result = run(command, args);
		if (result.status === 0 && !result.error) continue;
		write("false\n");
		writeError(failureDetails(command, args, result));
		return false;
	}
	write("true\n");
	return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exitCode = runQualityGate() ? 0 : 1;
}
