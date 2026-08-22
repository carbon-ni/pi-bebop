import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMembershipRuntime, type MembershipRuntime } from "../infra/membership-runtime.ts";
import { parseCrewManifest } from "../domain/index.ts";
import { maybeHandleStartupSocketJoin, normalizeStartupSocketPath } from "./startup-send.ts";

function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: "/project",
		hasUI: true,
		ui: { notify() {} },
		isProjectTrusted: () => true,
		...overrides,
	} as ExtensionContext;
}

function piWithFlag(value: unknown): ExtensionAPI {
	return { getFlag: () => value } as unknown as ExtensionAPI;
}

test("startup socket paths normalize leading @ and startup cwd", () => {
	assert.equal(normalizeStartupSocketPath("@.pi/intray/sockets/dev.sock", "/project"), "/project/.pi/intray/sockets/dev.sock");
	assert.equal(normalizeStartupSocketPath("sockets/dev.sock", "/project"), "/project/sockets/dev.sock");
});

test("startup selection uses the external root manifest for both layouts", async () => {
	for (const layout of ["bebop", "crew"]) {
		let request: any;
		const runtime = { join: async (value: unknown) => { request = value; return { ok: true, idempotent: false, membership: { member: { name: "dev", role: "developer" }, socketPath: `/worktree-B/.pi/${layout}/sockets/dev1.sock` } }; }, leave: async () => ({ ok: true, left: false }), getMembership: () => null } as unknown as MembershipRuntime;
		const selected = `/worktree-B/.pi/${layout}/sockets/dev1.sock`;
		assert.equal(await maybeHandleStartupSocketJoin(context({ cwd: "/worktree-A" }), piWithFlag(selected), { socket: "crew-socket" }, runtime, "/tmp/global.sock"), true);
		assert.deepEqual(request, { manifestPath: `/worktree-B/.pi/${layout}/crew.json`, socketPath: selected, globalSocketPath: "/tmp/global.sock" });
	}
});

test("startup rejects unsupported layouts without joining", async () => {
	let joins = 0;
	const runtime = {
		join: async () => { joins += 1; return { ok: true, idempotent: false, membership: undefined }; },
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const handled = await maybeHandleStartupSocketJoin(
		context(),
		piWithFlag("@.pi/other/sockets/dev.sock"),
		{ socket: "crew-socket" }, runtime, "/tmp/global.sock");
	assert.equal(handled, false);
	assert.equal(joins, 0);
});

test("startup rejects unsupported and unconfigured endpoints before claim", async () => {
	let claims = 0;
	const runtime = createMembershipRuntime({
		loadManifest: async () => parseCrewManifest({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }, "/root-B/.pi/bebop/crew.json"),
		claimEndpoint: (async () => { claims += 1; return { idempotent: false }; }) as never,
	});
	for (const target of ["/root-B/.pi/other/sockets/dev.sock", "/root-B/.pi/bebop/member.sock", "/root-B/.pi/bebop/sockets/../dev.sock", "/root-B/.pi/bebop/sockets/unknown.sock"]) {
		assert.equal(await maybeHandleStartupSocketJoin(context({ cwd: "/root-A" }), piWithFlag(target), { socket: "crew-socket" }, runtime, "/tmp/global.sock"), false);
	}
	assert.equal(claims, 0);
});

test("startup revalidates supported membership with the current global socket", async () => {
	const globalSockets: string[] = [];
	const runtime = {
		join: async (request: { globalSocketPath: string }) => {
			globalSockets.push(request.globalSocketPath);
			return { ok: true, idempotent: globalSockets.length > 1, membership: { member: { name: "dev", role: "developer" }, socketPath: "/project/.pi/bebop/sockets/dev.sock" } };
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const startupContext = context();
	const pi = piWithFlag(".pi/bebop/sockets/dev.sock");
	assert.equal(await maybeHandleStartupSocketJoin(startupContext, pi, { socket: "intray-socket" }, runtime, "/tmp/global-first.sock"), true);
	assert.equal(await maybeHandleStartupSocketJoin(startupContext, pi, { socket: "intray-socket" }, runtime, "/tmp/global-second.sock"), true);
	assert.deepEqual(globalSockets, ["/tmp/global-first.sock", "/tmp/global-second.sock"]);
});

test("untrusted or failed startup selection is explicit and does not create membership", async () => {
	let joins = 0;
	const runtime = {
		join: async () => { joins += 1; return { ok: false, error: new Error("occupied endpoint") }; },
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const untrusted = await maybeHandleStartupSocketJoin(
		context({ isProjectTrusted: () => false, hasUI: false }),
		piWithFlag(".pi/bebop/sockets/dev.sock"),
		{ socket: "intray-socket" },
		runtime,
		"/tmp/global.sock",
	);
	assert.equal(untrusted, false);
	assert.equal(joins, 0);
	const failed = await maybeHandleStartupSocketJoin(
		context(),
		piWithFlag(".pi/bebop/sockets/dev.sock"),
		{ socket: "intray-socket" },
		runtime,
		"/tmp/global.sock",
	);
	assert.equal(failed, false);
	assert.equal(joins, 1);
});
