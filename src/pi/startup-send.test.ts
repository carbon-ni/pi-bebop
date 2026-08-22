import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MembershipRuntime } from "../infra/membership-runtime.ts";
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

test("startup selection chooses the manifest adjacent to either supported layout", async () => {
	for (const layout of ["bebop", "crew"]) {
		let request: any;
		const runtime = { join: async (value: unknown) => { request = value; return { ok: true, idempotent: false, membership: { member: { name: "dev", role: "developer" }, socketPath: `/project/.pi/${layout}/sockets/dev.sock` } }; }, leave: async () => ({ ok: true, left: false }), getMembership: () => null } as unknown as MembershipRuntime;
		assert.equal(await maybeHandleStartupSocketJoin(context(), piWithFlag(`.pi/${layout}/sockets/dev.sock`), { socket: "crew-socket" }, runtime, "/tmp/global.sock"), true);
		assert.equal(request.manifestPath, `/project/.pi/${layout}/crew.json`);
	}
});

test("startup socket selection delegates one trusted join with canonical paths", async () => {
	let request: unknown;
	const runtime = {
		join: async (value: unknown) => { request = value; return { ok: true, idempotent: false, membership: { member: { name: "dev", role: "developer" }, socketPath: "/project/.pi/intray/sockets/dev.sock" } }; },
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const handled = await maybeHandleStartupSocketJoin(
		context(),
		piWithFlag("@.pi/intray/sockets/dev.sock"),
		{ socket: "intray-socket" },
		runtime,
		"/tmp/global.sock",
	);
	assert.equal(handled, true);
	assert.deepEqual(request, {
		manifestPath: "/project/.pi/intray/crew.json",
		socketPath: "/project/.pi/intray/sockets/dev.sock",
		globalSocketPath: "/tmp/global.sock",
	});
});

test("revalidates startup membership on every session start with the current global socket", async () => {
	const globalSockets: string[] = [];
	const runtime = {
		join: async (request: { globalSocketPath: string }) => {
			globalSockets.push(request.globalSocketPath);
			return { ok: true, idempotent: globalSockets.length > 1, membership: { member: { name: "dev", role: "developer" }, socketPath: "/project/.pi/intray/sockets/dev.sock" } };
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const startupContext = context();
	const pi = piWithFlag(".pi/intray/sockets/dev.sock");
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
		piWithFlag(".pi/intray/sockets/dev.sock"),
		{ socket: "intray-socket" },
		runtime,
		"/tmp/global.sock",
	);
	assert.equal(untrusted, false);
	assert.equal(joins, 0);
	const failed = await maybeHandleStartupSocketJoin(
		context(),
		piWithFlag(".pi/intray/sockets/dev.sock"),
		{ socket: "intray-socket" },
		runtime,
		"/tmp/global.sock",
	);
	assert.equal(failed, false);
	assert.equal(joins, 1);
});
