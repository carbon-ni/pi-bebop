import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CREW_INIT_PROJECT_DIR } from "../domain/index.ts";
import type { CrewInitFsAdapter, CrewInitPathKind } from "../application/crew-init-flow.ts";

/**
 * Node filesystem adapter for `pi-bebop crew init` (TASK-0054).
 *
 * - Reads kinds via lstat so symlinks are detected and rejected, never followed.
 * - Staging is created under the target project's `.pi` directory so the final
 *   `rename` is same-filesystem atomic.
 * - Publish uses `rename` (atomic within a filesystem); a concurrent winner
 *   surfaces as ENOTEMPTY/EEXIST and the flow reconciles.
 * - Removal is recursive-only for the private staging path and never touches
 *   pre-existing user paths.
 */

function isErrno(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

export function createNodeCrewInitFsAdapter(): CrewInitFsAdapter {
	const kindOf = async (absPath: string): Promise<CrewInitPathKind> => {
		try {
			const stat = await fs.lstat(absPath);
			if (stat.isSymbolicLink()) return "symlink";
			if (stat.isDirectory()) return "directory";
			return "file";
		} catch (error) {
			if (isErrno(error) && error.code === "ENOENT") return "missing";
			throw error;
		}
	};

	return {
		readKind: kindOf,
		async readFile(absPath) {
			try {
				return await fs.readFile(absPath, "utf8");
			} catch (error) {
				if (isErrno(error) && error.code === "ENOENT") return undefined;
				throw error;
			}
		},
		async writeFile(absPath, bytes) {
			await fs.mkdir(path.dirname(absPath), { recursive: true });
			await fs.writeFile(absPath, bytes, "utf8");
		},
		async mkdir(absPath) {
			await fs.mkdir(absPath, { recursive: true });
		},
		async createStaging(projectAbs) {
			const dotPi = path.join(projectAbs, ".pi");
			await fs.mkdir(dotPi, { recursive: true });
			const staging = path.join(dotPi, `.bebop-init-${randomUUID()}`);
			await fs.mkdir(staging);
			return staging;
		},
		async publishStaging(stagingAbs, targetAbs) {
			await fs.mkdir(path.dirname(targetAbs), { recursive: true });
			await fs.rename(stagingAbs, targetAbs);
		},
		async remove(absPath) {
			await fs.rm(absPath, { recursive: true, force: true });
		},
		async touchFile(absPath) {
			const stat = await fs.stat(absPath);
			const now = new Date();
			await fs.utimes(absPath, now, stat.mtime);
		},
		async mtimeNs(absPath) {
			try {
				const stat = await fs.stat(absPath);
				return Math.round(stat.mtimeMs * 1e6);
			} catch {
				return undefined;
			}
		},
	};
}
