import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as net from "node:net";

export type MemberEndpointErrorCode = "live-foreign" | "claim-conflict" | "occupied";

export class MemberEndpointError extends Error {
	readonly code: MemberEndpointErrorCode;

	constructor(code: MemberEndpointErrorCode, message: string) {
		super(message);
		this.name = "MemberEndpointError";
		this.code = code;
	}
}

export interface MemberEndpointDependencies {
	mkdir?: (directory: string, options: { recursive: true }) => Promise<string | undefined>;
	readlink?: (filePath: string) => Promise<string>;
	symlink?: (target: string, filePath: string) => Promise<void>;
	rename?: (oldPath: string, newPath: string) => Promise<void>;
	unlink?: (filePath: string) => Promise<void>;
	isSocketAlive?: (socketPath: string) => Promise<boolean>;
	acquireLock?: (lockPath: string) => Promise<() => Promise<void>>;
}

const defaultDependencies: Required<MemberEndpointDependencies> = {
	mkdir: (directory, options) => fs.mkdir(directory, options),
	readlink: (filePath) => fs.readlink(filePath),
	symlink: (target, filePath) => fs.symlink(target, filePath),
	rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
	unlink: (filePath) => fs.unlink(filePath),
	isSocketAlive: async (socketPath) =>
		await new Promise((resolve) => {
			const socket = net.createConnection(socketPath);
			const timeout = setTimeout(() => {
				socket.destroy();
				resolve(false);
			}, 300);
			socket.once("connect", () => {
				clearTimeout(timeout);
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => {
				clearTimeout(timeout);
				resolve(false);
			});
		}),
	acquireLock: async (lockPath) => {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(lockPath, "wx");
		} catch (error) {
			if (isCode(error, "EEXIST"))
				throw new MemberEndpointError(
					"claim-conflict",
					`member endpoint claim is already in progress: ${lockPath}`,
				);
			throw error;
		}
		return async () => {
			await handle.close();
			try {
				await fs.unlink(lockPath);
			} catch (error) {
				if (!isCode(error, "ENOENT")) throw error;
			}
		};
	},
};

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function normalizedTarget(endpointPath: string, target: string): string {
	return path.resolve(path.dirname(endpointPath), target);
}

async function createEndpoint(
	endpointPath: string,
	globalSocketPath: string,
	deps: Required<MemberEndpointDependencies>,
): Promise<{ claimed: true; idempotent: false }> {
	try {
		await deps.symlink(globalSocketPath, endpointPath);
		return { claimed: true, idempotent: false };
	} catch (error) {
		if (isCode(error, "EEXIST")) {
			throw new MemberEndpointError(
				"claim-conflict",
				`member endpoint was claimed concurrently: ${endpointPath}`,
			);
		}
		throw error;
	}
}

export async function probeMemberEndpoint(socketPath: string): Promise<boolean> {
	return defaultDependencies.isSocketAlive(socketPath);
}

export async function claimMemberEndpoint(
	endpointPath: string,
	globalSocketPath: string,
	dependencies: MemberEndpointDependencies = {},
): Promise<{ claimed: true; idempotent: boolean }> {
	const deps = { ...defaultDependencies, ...dependencies };
	await deps.mkdir(path.dirname(endpointPath), { recursive: true });
	const releaseLock = await deps.acquireLock(`${endpointPath}.claim`);
	try {
		let existingTarget: string;
		try {
			existingTarget = await deps.readlink(endpointPath);
		} catch (error) {
			if (isCode(error, "ENOENT")) return createEndpoint(endpointPath, globalSocketPath, deps);
			throw new MemberEndpointError("occupied", `member endpoint is not a symlink: ${endpointPath}`);
		}

		const currentTarget = path.resolve(globalSocketPath);
		const existingResolved = normalizedTarget(endpointPath, existingTarget);
		if (existingResolved === currentTarget) return { claimed: true, idempotent: true };
		if (await deps.isSocketAlive(existingResolved)) {
			throw new MemberEndpointError(
				"live-foreign",
				`member endpoint is owned by a live session: ${endpointPath}`,
			);
		}

		const reclaimPath = `${endpointPath}.reclaim.${path.basename(currentTarget)}`;
		try {
			await deps.rename(endpointPath, reclaimPath);
		} catch (error) {
			if (isCode(error, "ENOENT")) return createEndpoint(endpointPath, globalSocketPath, deps);
			if (isCode(error, "EEXIST")) {
				throw new MemberEndpointError(
					"claim-conflict",
					`member endpoint reclaim is already in progress: ${endpointPath}`,
				);
			}
			throw error;
		}

		try {
			return await createEndpoint(endpointPath, globalSocketPath, deps);
		} finally {
			try {
				await deps.unlink(reclaimPath);
			} catch (error) {
				if (!isCode(error, "ENOENT")) throw error;
			}
		}
	} finally {
		await releaseLock();
	}
}

export async function releaseMemberEndpoint(
	endpointPath: string,
	globalSocketPath: string,
	dependencies: MemberEndpointDependencies = {},
): Promise<{ released: boolean }> {
	const deps = { ...defaultDependencies, ...dependencies };
	try {
		await deps.readlink(endpointPath);
	} catch (error) {
		if (isCode(error, "ENOENT") || isCode(error, "EINVAL")) return { released: false };
		throw error;
	}

	const releaseLock = await deps.acquireLock(`${endpointPath}.claim`);
	try {
		let target: string;
		try {
			target = await deps.readlink(endpointPath);
		} catch (error) {
			if (isCode(error, "ENOENT") || isCode(error, "EINVAL")) return { released: false };
			throw error;
		}
		if (normalizedTarget(endpointPath, target) !== path.resolve(globalSocketPath)) return { released: false };
		await deps.unlink(endpointPath);
		return { released: true };
	} finally {
		await releaseLock();
	}
}
