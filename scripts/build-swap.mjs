import { access, rename, rm } from "node:fs/promises";

async function uniqueBackupPath(base, accessImpl = access) {
	for (let index = 0; ; index += 1) {
		const candidate = index === 0 ? base : `${base}-${index}`;
		try {
			await accessImpl(candidate);
		} catch (error) {
			if (error?.code === "ENOENT") return candidate;
			throw error;
		}
	}
}

export async function atomicSwapDirectory(staging, dist, backupBase, operations = {}) {
	const renameImpl = operations.rename ?? rename;
	const rmImpl = operations.rm ?? rm;
	const accessImpl = operations.access ?? access;
	const backup = await uniqueBackupPath(backupBase, accessImpl);
	let moved = false;
	let hadPreviousDist = false;
	let restored = false;
	try {
		try {
			await renameImpl(dist, backup);
			hadPreviousDist = true;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		try {
			await renameImpl(staging, dist);
			moved = true;
		} catch (error) {
			if (!hadPreviousDist) throw error;
			try {
				await renameImpl(backup, dist);
				restored = true;
			} catch (restoreError) {
				throw new Error(`Build install failed; recovery backup retained at ${backup}`, { cause: restoreError });
			}
			throw error;
		}
	} finally {
		if (restored || moved) await rmImpl(backup, { recursive: true, force: true });
		await rmImpl(staging, { recursive: true, force: true });
	}
}
