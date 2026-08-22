import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
export const DEFAULT_STALE_LOCK_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
};

export async function acquireBuildLock(
	lockPath,
	{ timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, staleMs = DEFAULT_STALE_LOCK_MS, pollMs = 25 } = {},
) {
	const started = Date.now();
	while (true) {
		try {
			await mkdir(lockPath);
			try {
				await writeFile(join(lockPath, "owner"), `${process.pid}\n${Date.now()}\n`, "utf8");
			} catch (error) {
				await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
			return async () => rm(lockPath, { recursive: true, force: true });
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			let owner;
			try {
				owner = (await readFile(join(lockPath, "owner"), "utf8")).trim().split("\n");
			} catch (readError) {
				if (!["ENOENT", "EISDIR"].includes(readError?.code)) throw readError;
			}
			const pid = Number(owner?.[0]);
			const created = Number(owner?.[1]);
			let lockAge = Number.POSITIVE_INFINITY;
			try {
				lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
			} catch (statError) {
				if (statError?.code !== "ENOENT") throw statError;
			}
			const stale = lockAge > staleMs;
			if (
				stale &&
				((Number.isInteger(pid) && pid > 0 && Number.isFinite(created) && !processAlive(pid)) ||
					(!Number.isInteger(pid) && !Number.isFinite(created)))
			) {
				await rm(lockPath, { recursive: true, force: true });
				continue;
			}
			if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring build lock: ${lockPath}`);
			await sleep(pollMs);
		}
	}
}
