import { rename, rm } from "node:fs/promises";

export async function atomicSwapDirectory(staging, dist, backup) {
	let moved = false;
	try {
		try {
			await rename(dist, backup);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		try {
			await rename(staging, dist);
			moved = true;
		} catch (error) {
			await rename(backup, dist).catch(() => undefined);
			throw error;
		}
		await rm(backup, { recursive: true, force: true });
	} finally {
		if (!moved) await rename(backup, dist).catch(() => undefined);
		await rm(backup, { recursive: true, force: true });
		await rm(staging, { recursive: true, force: true });
	}
}
