import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	claimMemberEndpoint,
	MemberEndpointError,
	probeMemberEndpoint,
	releaseMemberEndpoint,
} from "./member-endpoint.ts";

let root: string;

test("member probe returns true, false on connection errors, and false on timeout with cleanup", async () => {
	for (const outcome of ["connect", "error", "timeout"] as const) {
		const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
		let destroyed = false;
		socket.destroy = () => {
			destroyed = true;
		};
		let timer: (() => void) | undefined;
		const result = probeMemberEndpoint("/configured/member.sock", {
			createConnection: () => socket,
			setTimeout: (callback) => {
				timer = callback as () => void;
				return 1 as never;
			},
			clearTimeout: () => undefined,
		});
		if (outcome === "connect" || outcome === "error") socket.emit(outcome);
		else timer!();
		assert.equal(await result, outcome === "connect");
		assert.equal(destroyed, true);
	}
});

async function socketServer(socketPath: string): Promise<net.Server> {
	const server = net.createServer();
	await fs.mkdir(path.dirname(socketPath), { recursive: true });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	return server;
}

async function closeServer(server: net.Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await fs.rm(socketPath, { force: true });
}

before(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-member-"));
});
after(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("member endpoint ownership", () => {
	test("claims a missing endpoint, creates parents, and is idempotent", async () => {
		const endpoint = path.join(root, "project", ".pi", "intray", "sockets", "dev.sock");
		const globalSocket = path.join(root, "global", "dev.sock");
		const server = await socketServer(globalSocket);
		try {
			assert.deepEqual(await claimMemberEndpoint(endpoint, globalSocket), { claimed: true, idempotent: false });
			assert.equal(await fs.readlink(endpoint), globalSocket);
			assert.deepEqual(await claimMemberEndpoint(endpoint, globalSocket), { claimed: true, idempotent: true });
		} finally {
			await closeServer(server, globalSocket);
		}
	});

	test("protects live foreign links and reclaims stale links in both layouts", async () => {
		for (const layout of ["bebop", "crew"]) {
			const endpoint = path.join(root, "project", ".pi", layout, "sockets", "dev.sock");
			const foreignSocket = path.join(root, "global", `${layout}-foreign.sock`);
			const currentSocket = path.join(root, "global", `${layout}-current.sock`);
			const server = await socketServer(foreignSocket);
			await fs.mkdir(path.dirname(endpoint), { recursive: true });
			await fs.symlink(foreignSocket, endpoint);
			try {
				await assert.rejects(
					() => claimMemberEndpoint(endpoint, currentSocket),
					(error: unknown) => error instanceof MemberEndpointError && error.code === "live-foreign",
				);
				assert.equal(await fs.readlink(endpoint), foreignSocket);
				await fs.unlink(endpoint);
				await fs.symlink(path.join(root, "missing", `${layout}-stale.sock`), endpoint);
				assert.deepEqual(await claimMemberEndpoint(endpoint, currentSocket), {
					claimed: true,
					idempotent: false,
				});
				assert.equal(await fs.readlink(endpoint), currentSocket);
			} finally {
				await closeServer(server, foreignSocket);
				await fs.rm(endpoint, { force: true });
			}
		}
	});

	test("rejects a live foreign endpoint without modifying it", async () => {
		const endpoint = path.join(root, "foreign", "dev.sock");
		const foreignSocket = path.join(root, "global", "foreign.sock");
		const currentSocket = path.join(root, "global", "current.sock");
		const server = await socketServer(foreignSocket);
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.symlink(foreignSocket, endpoint);
		try {
			await assert.rejects(
				() => claimMemberEndpoint(endpoint, currentSocket),
				(error: unknown) => error instanceof MemberEndpointError && error.code === "live-foreign",
			);
			assert.equal(await fs.readlink(endpoint), foreignSocket);
		} finally {
			await closeServer(server, foreignSocket);
		}
	});

	test("replaces a stale endpoint and lets only one concurrent reclaim win", async () => {
		const endpoint = path.join(root, "stale", "dev.sock");
		const staleSocket = path.join(root, "missing", "old.sock");
		const currentA = path.join(root, "global", "a.sock");
		const currentB = path.join(root, "global", "b.sock");
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.symlink(staleSocket, endpoint);

		const results = await Promise.allSettled([
			claimMemberEndpoint(endpoint, currentA),
			claimMemberEndpoint(endpoint, currentB),
		]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(results.filter((result) => result.status === "rejected").length, 1);
		const winner = await fs.readlink(endpoint);
		assert.ok(winner === currentA || winner === currentB);
		const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		assert.ok(rejected?.reason instanceof MemberEndpointError);
		assert.equal(rejected.reason.code, "claim-conflict");
	});

	test("release removes only the endpoint owned by the current socket", async () => {
		const endpoint = path.join(root, "release", "dev.sock");
		const ownedSocket = path.join(root, "global", "owned.sock");
		const foreignSocket = path.join(root, "global", "foreign.sock");
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.symlink(foreignSocket, endpoint);
		assert.deepEqual(await releaseMemberEndpoint(endpoint, ownedSocket), { released: false });
		assert.equal(await fs.readlink(endpoint), foreignSocket);
		await fs.unlink(endpoint);
		await fs.symlink(ownedSocket, endpoint);
		assert.deepEqual(await releaseMemberEndpoint(endpoint, ownedSocket), { released: true });
		await assert.rejects(() => fs.lstat(endpoint), /ENOENT/);
		assert.deepEqual(await releaseMemberEndpoint(endpoint, ownedSocket), { released: false });
		assert.deepEqual(await releaseMemberEndpoint(path.join(root, "missing-parent", "dev.sock"), ownedSocket), {
			released: false,
		});
		const regularFile = path.join(root, "release", "regular.sock");
		await fs.writeFile(regularFile, "not a symlink");
		assert.deepEqual(await releaseMemberEndpoint(regularFile, ownedSocket), { released: false });
	});

	test("rechecks ownership under the claim lock before unlinking", async () => {
		const endpoint = "/tmp/release-race.sock";
		const ownedSocket = "/tmp/owned.sock";
		const foreignSocket = "/tmp/foreign.sock";
		let reads = 0;
		let unlinks = 0;
		const result = await releaseMemberEndpoint(endpoint, ownedSocket, {
			readlink: async () => {
				reads += 1;
				if (reads === 1) return ownedSocket;
				return foreignSocket;
			},
			acquireLock: async () => async () => undefined,
			unlink: async () => {
				unlinks += 1;
			},
		});
		assert.deepEqual(result, { released: false });
		assert.equal(reads, 2);
		assert.equal(unlinks, 0);
	});

	test("supports injected filesystem and liveness seams", async () => {
		const calls: string[] = [];
		const files = new Map<string, string>();
		const endpoint = "/tmp/endpoint.sock";
		const globalSocket = "/tmp/global.sock";
		const result = await claimMemberEndpoint(endpoint, globalSocket, {
			mkdir: async () => undefined,
			readlink: async (filePath) => {
				const value = files.get(filePath);
				if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
				return value;
			},
			symlink: async (target, filePath) => {
				calls.push(`symlink:${target}:${filePath}`);
				if (files.has(filePath)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
				files.set(filePath, target);
			},
			unlink: async () => undefined,
			isSocketAlive: async () => false,
			acquireLock: async () => async () => undefined,
		});
		assert.deepEqual(result, { claimed: true, idempotent: false });
		assert.equal(calls.length, 1);
	});
});
