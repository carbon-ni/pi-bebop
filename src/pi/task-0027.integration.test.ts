import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMembershipRuntime } from "../infra/membership-runtime.ts";
import { readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import { appendMembershipContext } from "./membership-context.ts";
import { restorePersistedMembership } from "./membership-lifecycle.ts";

async function fixture(layout: "bebop" | "crew" = "bebop") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-0027-"));
	const crew = path.join(root, ".pi", layout);
	const instructions = path.join(crew, "instructions");
	const sockets = path.join(crew, "sockets");
	await fs.mkdir(instructions, { recursive: true });
	await fs.mkdir(sockets, { recursive: true });
	const manifestPath = path.join(crew, "crew.json");
	const socketPath = path.join(sockets, "dev.sock");
	const globalSocketPath = path.join(root, "global.sock");
	await fs.writeFile(path.join(instructions, "common.md"), "old common\n");
	await fs.writeFile(path.join(instructions, "dev.md"), "old role\n");
	await fs.writeFile(
		manifestPath,
		JSON.stringify({
			version: 2,
			commonInstructionsFile: "instructions/common.md",
			members: [
				{ name: "dev", role: "developer", socket: "sockets/dev.sock", instructionsFile: "instructions/dev.md" },
			],
		}),
	);
	return {
		root,
		manifestPath,
		socketPath,
		globalSocketPath,
		async cleanup() {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

function runtimeFor(crew: Awaited<ReturnType<typeof fixture>>, claimCount?: { value: number }) {
	return createMembershipRuntime({
		loadManifest: (manifestPath) => readTrustedCrewManifest(manifestPath, crew.root, () => true),
		claimEndpoint: async () => {
			if (claimCount) claimCount.value += 1;
			return { claimed: true, idempotent: false };
		},
		releaseEndpoint: async () => ({ released: true }),
	});
}

test("loads file-backed instructions from the compatibility .pi/crew layout", async () => {
	const crew = await fixture("crew");
	try {
		const manifest = await readTrustedCrewManifest(crew.manifestPath, crew.root, () => true);
		assert.equal(manifest.members[0]?.instructions, "old role\n");
	} finally {
		await crew.cleanup();
	}
});

test("rejects an invalid member atomically before claiming any endpoint", async () => {
	const crew = await fixture();
	try {
		await fs.writeFile(
			crew.manifestPath,
			JSON.stringify({
				version: 1,
				members: [
					{
						name: "dev",
						role: "developer",
						socket: "sockets/dev.sock",
						instructionsFile: "instructions/dev.md",
					},
					{ name: "qa", role: "qa", socket: "sockets/qa.sock", instructionsFile: "instructions/missing.md" },
				],
			}),
		);
		const claimed = { value: 0 };
		const result = await runtimeFor(crew, claimed).join({
			manifestPath: crew.manifestPath,
			socketPath: crew.socketPath,
			globalSocketPath: crew.globalSocketPath,
		});
		assert.equal(result.ok, false);
		assert.equal(claimed.value, 0);
	} finally {
		await crew.cleanup();
	}
});

test("rejects a missing common instructions file atomically before claiming any endpoint", async () => {
	const crew = await fixture();
	try {
		await fs.writeFile(
			crew.manifestPath,
			JSON.stringify({
				version: 2,
				commonInstructionsFile: "instructions/missing-common.md",
				members: [
					{
						name: "dev",
						role: "developer",
						socket: "sockets/dev.sock",
						instructionsFile: "instructions/dev.md",
					},
				],
			}),
		);
		const claimed = { value: 0 };
		const result = await runtimeFor(crew, claimed).join({
			manifestPath: crew.manifestPath,
			socketPath: crew.socketPath,
			globalSocketPath: crew.globalSocketPath,
		});
		assert.equal(result.ok, false);
		assert.equal(claimed.value, 0);
	} finally {
		await crew.cleanup();
	}
});

test("injects distinct common and Role instructions through before-agent-start context", async () => {
	const crew = await fixture();
	try {
		const runtime = runtimeFor(crew);
		const joined = await runtime.join({
			manifestPath: crew.manifestPath,
			socketPath: crew.socketPath,
			globalSocketPath: crew.globalSocketPath,
		});
		assert.equal(joined.ok, true);
		if (joined.ok) {
			const context = appendMembershipContext("Base system", joined.membership);
			assert.match(context, /Common Crew instructions:\nold common\n/);
			assert.match(context, /Role instructions: old role\n/);
		}
	} finally {
		await crew.cleanup();
	}
});

test("keeps active common and Role instruction snapshots unchanged after edits", async () => {
	const crew = await fixture();
	try {
		const runtime = runtimeFor(crew);
		const joined = await runtime.join({
			manifestPath: crew.manifestPath,
			socketPath: crew.socketPath,
			globalSocketPath: crew.globalSocketPath,
		});
		assert.equal(joined.ok, true);
		await fs.writeFile(path.join(path.dirname(crew.manifestPath), "instructions/common.md"), "new common\n");
		await fs.writeFile(path.join(path.dirname(crew.manifestPath), "instructions/dev.md"), "new role\n");
		if (joined.ok) {
			const context = appendMembershipContext("Base system", joined.membership);
			assert.match(context, /Common Crew instructions:\nold common\n/);
			assert.match(context, /Role instructions: old role\n/);
			assert.doesNotMatch(context, /new common|new role/);
		}
	} finally {
		await crew.cleanup();
	}
});

test("restores the current common and Role instruction snapshots from changed files", async () => {
	const crew = await fixture();
	try {
		const runtime = runtimeFor(crew);
		assert.equal(
			(
				await runtime.join({
					manifestPath: crew.manifestPath,
					socketPath: crew.socketPath,
					globalSocketPath: crew.globalSocketPath,
				})
			).ok,
			true,
		);
		await fs.writeFile(path.join(path.dirname(crew.manifestPath), "instructions/common.md"), "restored common\n");
		await fs.writeFile(path.join(path.dirname(crew.manifestPath), "instructions/dev.md"), "restored role\n");
		const restoredRuntime = runtimeFor(crew);
		const restored = await restorePersistedMembership({
			runtime: restoredRuntime,
			persisted: { active: true, socketPath: crew.socketPath, manifestPath: crew.manifestPath },
			startupSocketSelected: false,
			globalSocketPath: crew.globalSocketPath,
			manifestPathForSocket: () => crew.manifestPath,
			announce: () => undefined,
			reportFailure: assert.fail,
		});
		assert.equal(restored, true);
		const membership = restoredRuntime.getMembership();
		assert.ok(membership);
		const context = appendMembershipContext("Base system", membership);
		assert.match(context, /Common Crew instructions:\nrestored common\n/);
		assert.match(context, /Role instructions: restored role\n/);
	} finally {
		await crew.cleanup();
	}
});

test("refreshes both common and Role instructions after leave and rejoin", async () => {
	const crew = await fixture();
	try {
		const runtime = runtimeFor(crew);
		const request = {
			manifestPath: crew.manifestPath,
			socketPath: crew.socketPath,
			globalSocketPath: crew.globalSocketPath,
		};
		assert.equal((await runtime.join(request)).ok, true);
		assert.equal(runtime.getMembership()?.member.instructions, "old role\n");
		assert.equal((await runtime.leave()).ok, true);
		await fs.writeFile(path.join(path.dirname(crew.manifestPath), "instructions/common.md"), "new common\n");
		await fs.writeFile(path.join(path.dirname(crew.manifestPath), "instructions/dev.md"), "new role\n");
		assert.equal((await runtime.join(request)).ok, true);
		assert.equal(runtime.getMembership()?.manifest.commonInstructions, "new common\n");
		assert.equal(runtime.getMembership()?.member.instructions, "new role\n");
	} finally {
		await crew.cleanup();
	}
});
