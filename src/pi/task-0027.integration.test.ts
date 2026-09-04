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
	await fs.writeFile(path.join(instructions, "dev.md"), "old role\n");
	await fs.writeFile(
		manifestPath,
		JSON.stringify({
			version: 1,
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

test("injects file-backed Role instructions through the before-agent-start context", async () => {
	const crew = await fixture();
	try {
		const runtime = runtimeFor(crew);
		const joined = await runtime.join({
			manifestPath: crew.manifestPath,
			socketPath: crew.socketPath,
			globalSocketPath: crew.globalSocketPath,
		});
		assert.equal(joined.ok, true);
		if (joined.ok)
			assert.match(appendMembershipContext("Base system", joined.membership), /Role instructions: old role\n/);
	} finally {
		await crew.cleanup();
	}
});

test("keeps the active instruction snapshot unchanged after the file is edited", async () => {
	const crew = await fixture();
	try {
		const runtime = runtimeFor(crew);
		const joined = await runtime.join({
			manifestPath: crew.manifestPath,
			socketPath: crew.socketPath,
			globalSocketPath: crew.globalSocketPath,
		});
		assert.equal(joined.ok, true);
		await fs.writeFile(path.join(path.dirname(crew.manifestPath), "instructions/dev.md"), "new role\n");
		if (joined.ok)
			assert.match(appendMembershipContext("Base system", joined.membership), /Role instructions: old role\n/);
	} finally {
		await crew.cleanup();
	}
});

test("restores the current instruction snapshot from the changed file", async () => {
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
		assert.match(appendMembershipContext("Base system", membership), /Role instructions: restored role\n/);
	} finally {
		await crew.cleanup();
	}
});

test("loads common instructions as a stable snapshot and refreshes them on leave/rejoin", async () => {
	const crew = await fixture();
	try {
		const instructionsDir = path.join(crew.root, ".pi", "bebop", "instructions");
		await fs.writeFile(path.join(instructionsDir, "common.md"), "old common\n");
		await fs.writeFile(
			crew.manifestPath,
			JSON.stringify({
				version: 2,
				commonInstructionsFile: "instructions/common.md",
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
		const request = {
			manifestPath: crew.manifestPath,
			socketPath: crew.socketPath,
			globalSocketPath: crew.globalSocketPath,
		};
		const runtime = runtimeFor(crew);
		assert.equal((await runtime.join(request)).ok, true);
		const first = appendMembershipContext("Base system", runtime.getMembership());
		assert.ok(first.indexOf("Common crew instructions: old common") < first.indexOf("Role instructions: old role"));
		await fs.writeFile(path.join(instructionsDir, "common.md"), "new common\n");
		assert.match(appendMembershipContext("Base system", runtime.getMembership()), /old common/);
		assert.equal((await runtime.leave()).ok, true);
		assert.equal((await runtime.join(request)).ok, true);
		assert.match(appendMembershipContext("Base system", runtime.getMembership()), /new common/);
	} finally {
		await crew.cleanup();
	}
});

test("refreshes instructions from old to new content after leave and rejoin", async () => {
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
		await fs.writeFile(path.join(path.dirname(crew.manifestPath), "instructions/dev.md"), "new role\n");
		assert.equal((await runtime.join(request)).ok, true);
		assert.equal(runtime.getMembership()?.member.instructions, "new role\n");
	} finally {
		await crew.cleanup();
	}
});
