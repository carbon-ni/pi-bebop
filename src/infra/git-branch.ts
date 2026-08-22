import { execFile as nodeExecFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

type ExecFile = (
	file: string,
	args: string[],
	options: { cwd: string },
) => Promise<{ stdout: string }>;

const execFile = promisify(nodeExecFile) as ExecFile;

export async function getCurrentGitBranch(cwd = process.cwd(), run: ExecFile = execFile): Promise<string | null> {
	try {
		const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
		const branch = stdout.trim();
		return branch && branch !== "HEAD" ? branch : null;
	} catch {
		return null;
	}
}

export async function getGitProjectName(cwd = process.cwd(), run: ExecFile = execFile): Promise<string | null> {
	try {
		const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
		const projectName = path.basename(stdout.trim());
		return projectName || null;
	} catch {
		return null;
	}
}
