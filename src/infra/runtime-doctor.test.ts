import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import net from "node:net";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { currentRuntimeCompatibility, type CrewManifest } from "../domain/index.ts";
import { diagnoseRuntimeCompatibility } from "../application/runtime-doctor.ts";
import { createRuntimeDoctorDependencies } from "./runtime-doctor.ts";

async function runtimePeer(t: TestContext) {
	const directory = await mkdtemp(path.join(tmpdir(), "doctor-rpc-"));
	const socketPath = path.join(directory, "runtime.sock");
	const sockets = new Set<net.Socket>();
	let receive!: (peer: { reply: (result: unknown, id?: string) => void }) => void;
	const requestReceived = new Promise<{ reply: (result: unknown, id?: string) => void }>((resolve) => {
		receive = resolve;
	});
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
			receive({
				reply: (result, id = request.id) => socket.end(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`),
			});
		});
	});
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return { socketPath, requestReceived };
}

test("doctor transport accepts a response after two seconds within the requested budget", async (t) => {
	const peer = await runtimePeer(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const dependencies = createRuntimeDoctorDependencies();
	const compatibility = currentRuntimeCompatibility();

	const pending = dependencies.probeRuntime(peer.socketPath, {
		timeoutMs: 10_000,
		signal: new AbortController().signal,
	});
	const { reply } = await peer.requestReceived;
	t.mock.timers.tick(3_000);
	reply(compatibility);

	assert.deepEqual(await pending, { kind: "response", value: compatibility });
});

test("doctor transport times out when the requested budget expires", async (t) => {
	const peer = await runtimePeer(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const dependencies = createRuntimeDoctorDependencies();

	const pending = dependencies.probeRuntime(peer.socketPath, {
		timeoutMs: 10_000,
		signal: new AbortController().signal,
	});
	await peer.requestReceived;
	t.mock.timers.tick(10_000);

	assert.deepEqual(await pending, { kind: "error", code: "timeout" });
});

const compatibility = currentRuntimeCompatibility();
const { packageVersion: _version, ...withoutPackageVersion } = compatibility;
const { buildCommit: _commit, ...withoutBuildCommit } = compatibility;
const { protocol: _protocol, ...withoutProtocol } = compatibility;

for (const [scenario, response, expectedStatus] of [
	["current version", compatibility, "compatible"],
	["missing package version", withoutPackageVersion, "missing-version"],
	["missing build commit", withoutBuildCommit, "missing-version"],
	["missing protocol", withoutProtocol, "missing-version"],
	["all version fields missing", { product: "pi-bebop", capabilities: [] }, "missing-version"],
	["invalid package version", { ...compatibility, packageVersion: "dev" }, "malformed-version"],
	["oversized package version", { ...compatibility, packageVersion: "x".repeat(65) }, "malformed-peer"],
	["invalid capability type", { ...compatibility, capabilities: [42] }, "malformed-peer"],
	["too many capabilities", { ...compatibility, capabilities: Array(129).fill("feature") }, "malformed-peer"],
	["unexpected private field", { ...compatibility, credentials: "private" }, "malformed-peer"],
] as const) {
	test(`doctor diagnoses ${scenario} through the real RPC adapter`, async (t) => {
		const peer = await runtimePeer(t);
		const dependencies = createRuntimeDoctorDependencies();
		const manifest: CrewManifest = {
			version: 2,
			members: [{ name: "Alice", role: "developer", socket: "runtime.sock", socketPath: peer.socketPath }],
			presence: { notifications: true },
		};

		const pending = diagnoseRuntimeCompatibility(
			{ projectRoot: "/project", timeoutSeconds: 1, diagnostic: false, signal: new AbortController().signal },
			{
				...dependencies,
				discoverManifestPaths: () => ["/project/crew.json"],
				manifestExists: async () => true,
				readManifest: async () => manifest,
			},
		);
		const { reply } = await peer.requestReceived;
		reply(response);
		const diagnosis = await pending;

		assert.equal(diagnosis.crews[0]?.members[0]?.status, expectedStatus);
		assert.doesNotMatch(JSON.stringify(diagnosis), /credentials|private|runtime\.sock/);
	});
}

const filesystemManifest = {
	version: 2,
	members: [{ name: "Alice", role: "developer", socket: "sockets/runtime.sock" }],
	presence: { notifications: true },
};

async function diagnoseFilesystemProject(t: TestContext, layouts: readonly string[]) {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "doctor-manifests-"));
	t.after(() => rm(projectRoot, { recursive: true, force: true }));
	for (const layout of layouts) {
		const directory = path.join(projectRoot, ".pi", layout);
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, "crew.json"), JSON.stringify(filesystemManifest));
	}
	const dependencies = createRuntimeDoctorDependencies();
	return diagnoseRuntimeCompatibility(
		{ projectRoot, timeoutSeconds: 1, diagnostic: false, signal: new AbortController().signal },
		{ ...dependencies, probeRuntime: async () => ({ kind: "response", value: currentRuntimeCompatibility() }) },
	);
}

for (const [scenario, layouts, expectedCrews] of [
	["empty project", [], 0],
	["modern manifest only", ["bebop"], 1],
	["legacy manifest only", ["crew"], 1],
	["both supported manifests", ["bebop", "crew"], 2],
] as const) {
	test(`doctor handles ${scenario} without phantom configuration errors`, async (t) => {
		const result = await diagnoseFilesystemProject(t, layouts);
		assert.equal(result.status, expectedCrews === 0 ? "empty" : "healthy");
		assert.equal(result.configuration, "healthy");
		assert.equal(result.crews.length, expectedCrews);
	});
}

for (const [scenario, prepare] of [
	["malformed", async (projectRoot: string) => writeFile(path.join(projectRoot, ".pi", "bebop", "crew.json"), "{")],
	["unreadable", async (projectRoot: string) => mkdir(path.join(projectRoot, ".pi", "bebop", "crew.json"))],
] as const) {
	test(`doctor reports ${scenario} filesystem manifests as configuration errors`, async (t) => {
		const projectRoot = await mkdtemp(path.join(tmpdir(), "doctor-invalid-manifest-"));
		t.after(() => rm(projectRoot, { recursive: true, force: true }));
		await mkdir(path.join(projectRoot, ".pi", "bebop"), { recursive: true });
		await prepare(projectRoot);
		const dependencies = createRuntimeDoctorDependencies();
		const result = await diagnoseRuntimeCompatibility(
			{ projectRoot, timeoutSeconds: 1, diagnostic: false, signal: new AbortController().signal },
			{ ...dependencies, probeRuntime: async () => ({ kind: "response", value: currentRuntimeCompatibility() }) },
		);
		assert.equal(result.status, "issues");
		assert.equal(result.configuration, "issues");
		assert.equal(result.crews[0]?.status, "configuration-error");
	});
}

for (const [scenario, prepare] of [
	[
		"dangling manifest symlink",
		async (projectRoot: string) => {
			const directory = path.join(projectRoot, ".pi", "bebop");
			await mkdir(directory, { recursive: true });
			await symlink("missing-crew.json", path.join(directory, "crew.json"));
		},
	],
	[
		"manifest path under a non-directory",
		async (projectRoot: string) => {
			await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
			await writeFile(path.join(projectRoot, ".pi", "bebop"), "not a directory");
		},
	],
] as const) {
	test(`doctor reports ${scenario} as configuration errors`, async (t) => {
		const projectRoot = await mkdtemp(path.join(tmpdir(), "doctor-layout-error-"));
		t.after(() => rm(projectRoot, { recursive: true, force: true }));
		await prepare(projectRoot);
		const dependencies = createRuntimeDoctorDependencies();
		const result = await diagnoseRuntimeCompatibility(
			{ projectRoot, timeoutSeconds: 1, diagnostic: false, signal: new AbortController().signal },
			{ ...dependencies, probeRuntime: async () => ({ kind: "response", value: currentRuntimeCompatibility() }) },
		);
		assert.equal(result.configuration, "issues");
		assert.equal(result.crews[0]?.status, "configuration-error");
	});
}

test("doctor preserves unsafe manifest errors after candidate existence filtering", async (t) => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "doctor-unsafe-manifest-"));
	const outsideRoot = await mkdtemp(path.join(tmpdir(), "doctor-outside-"));
	t.after(async () => {
		await rm(projectRoot, { recursive: true, force: true });
		await rm(outsideRoot, { recursive: true, force: true });
	});
	const manifestPath = path.join(outsideRoot, "crew.json");
	await writeFile(manifestPath, JSON.stringify(filesystemManifest));
	const dependencies = createRuntimeDoctorDependencies();
	const result = await diagnoseRuntimeCompatibility(
		{ projectRoot, timeoutSeconds: 1, diagnostic: false, signal: new AbortController().signal },
		{
			...dependencies,
			discoverManifestPaths: () => [manifestPath],
			manifestExists: async () => true,
			probeRuntime: async () => ({ kind: "response", value: currentRuntimeCompatibility() }),
		},
	);
	assert.equal(result.configuration, "issues");
	assert.equal(result.crews[0]?.status, "configuration-error");
});

test("doctor transport still rejects an uncorrelated missing-version response", async (t) => {
	const peer = await runtimePeer(t);
	const dependencies = createRuntimeDoctorDependencies();

	const pending = dependencies.probeRuntime(peer.socketPath, {
		timeoutMs: 1_000,
		signal: new AbortController().signal,
	});
	const { reply } = await peer.requestReceived;
	reply({ product: "pi-bebop", capabilities: [] }, "wrong-request");

	assert.deepEqual(await pending, { kind: "error", code: "mismatched-id" });
});
