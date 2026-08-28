import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMembershipRuntime, type MembershipRuntime } from "../infra/membership-runtime.ts";
import { parseCrewManifest } from "../domain/index.ts";
import {
	maybeHandleStartupRoleJoin,
	maybeHandleStartupSocketJoin,
	normalizeStartupSocketPath,
	resolveStartupCrewRole,
} from "./startup-send.ts";

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

test("startup role resolver selects configured socket without guessing filenames", async () => {
	const reads: string[] = [];
	const result = await resolveStartupCrewRole("developer", "/project", true, {
		manifestExists: async (manifestPath) => manifestPath.endsWith("/bebop/crew.json"),
		readManifest: async (manifestPath) => {
			reads.push(manifestPath);
			return parseCrewManifest(
				{ version: 1, members: [{ name: "Bob", role: "developer", socket: "sockets/custom.sock" }] },
				manifestPath,
			);
		},
	});
	assert.deepEqual(result, {
		ok: true,
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: "/project/.pi/bebop/sockets/custom.sock",
	});
	assert.deepEqual(reads, ["/project/.pi/bebop/crew.json"]);
});

test("startup role resolver checks trust before manifest IO and rejects both layouts", async () => {
	let io = 0;
	const dependencies = {
		manifestExists: async () => {
			io += 1;
			return true;
		},
		readManifest: async () => {
			io += 1;
			throw new Error("must not read");
		},
	};
	assert.equal(
		(await resolveStartupCrewRole("developer", "/project", false, dependencies)).code,
		"untrusted-project",
	);
	assert.equal(io, 0);
	assert.equal(
		(
			await resolveStartupCrewRole("developer", "/project", true, {
				...dependencies,
				manifestExists: async () => false,
			})
		).code,
		"missing-manifest",
	);
	assert.equal(
		(
			await resolveStartupCrewRole("developer", "/project", true, {
				...dependencies,
				manifestExists: async () => true,
			})
		).code,
		"ambiguous-manifest",
	);
});

test("startup role join delegates selected manifest socket and does not activate on failure", async () => {
	const joins: unknown[] = [];
	const runtime = {
		join: async (request: unknown) => {
			joins.push(request);
			return {
				ok: true,
				idempotent: false,
				membership: { member: { name: "Bob", role: "developer" }, socketPath: "/project/custom.sock" },
			};
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const joined = await maybeHandleStartupRoleJoin(
		context(),
		piWithFlag("developer"),
		{ role: "crew-role" },
		runtime,
		"/tmp/global.sock",
		async () => ({ ok: true, manifestPath: "/project/.pi/bebop/crew.json", socketPath: "/project/custom.sock" }),
	);
	assert.equal(joined, true);
	assert.deepEqual(joins, [
		{
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/custom.sock",
			globalSocketPath: "/tmp/global.sock",
		},
	]);
});

test("startup role join reports actionable invalid intake configuration", async () => {
	const notices: string[] = [];
	let joins = 0;
	const manifestPath = "/project/.pi/bebop/crew.json";
	const runtime = {
		join: async () => {
			joins += 1;
			return { ok: false, error: new Error("must not join") };
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const handled = await maybeHandleStartupRoleJoin(
		context({ ui: { notify: (message: string) => notices.push(message) } }),
		piWithFlag("developer"),
		{ role: "crew-role" },
		runtime,
		"/tmp/global.sock",
		() =>
			resolveStartupCrewRole("developer", "/project", true, {
				manifestExists: async (candidate) => candidate === manifestPath,
				readManifest: async (candidate) =>
					parseCrewManifest(
						{
							version: 1,
							members: [
								{ name: "Mary", role: "po", socket: "sockets/mary.sock" },
								{ name: "Tony", role: "lead", socket: "sockets/tony.sock" },
							],
							intake: { contact: "Ghost" },
						},
						candidate,
					),
			}),
	);
	assert.equal(handled, false);
	assert.equal(joins, 0);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /^Crew startup send failed:/);
	assert.match(notices[0]!, /intake\.contact rejected value 'Ghost'/);
	assert.match(notices[0]!, /Next: verify the target and startup flags, then retry\./);
	assert.match(notices[0]!, /\(code: startup-send-failed\)$/);
});

test("startup socket paths normalize leading @ and startup cwd", () => {
	assert.equal(
		normalizeStartupSocketPath("@.pi/intray/sockets/dev.sock", "/project"),
		"/project/.pi/intray/sockets/dev.sock",
	);
	assert.equal(normalizeStartupSocketPath("sockets/dev.sock", "/project"), "/project/sockets/dev.sock");
});

test("startup selection uses the external root manifest for both layouts", async () => {
	for (const layout of ["bebop", "crew"]) {
		let request: any;
		const runtime = {
			join: async (value: unknown) => {
				request = value;
				return {
					ok: true,
					idempotent: false,
					membership: {
						member: { name: "dev", role: "developer" },
						socketPath: `/worktree-B/.pi/${layout}/sockets/dev1.sock`,
					},
				};
			},
			leave: async () => ({ ok: true, left: false }),
			getMembership: () => null,
		} as unknown as MembershipRuntime;
		const selected = `/worktree-B/.pi/${layout}/sockets/dev1.sock`;
		assert.equal(
			await maybeHandleStartupSocketJoin(
				context({ cwd: "/worktree-A" }),
				piWithFlag(selected),
				{ socket: "crew-socket" },
				runtime,
				"/tmp/global.sock",
			),
			true,
		);
		assert.deepEqual(request, {
			manifestPath: `/worktree-B/.pi/${layout}/crew.json`,
			socketPath: selected,
			globalSocketPath: "/tmp/global.sock",
		});
	}
});

test("startup rejects unsupported layouts without joining", async () => {
	let joins = 0;
	const runtime = {
		join: async () => {
			joins += 1;
			return { ok: true, idempotent: false, membership: undefined };
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const handled = await maybeHandleStartupSocketJoin(
		context(),
		piWithFlag("@.pi/other/sockets/dev.sock"),
		{ socket: "crew-socket" },
		runtime,
		"/tmp/global.sock",
	);
	assert.equal(handled, false);
	assert.equal(joins, 0);
});

test("startup rejects unsupported and unconfigured endpoints before claim", async () => {
	let claims = 0;
	const runtime = createMembershipRuntime({
		loadManifest: async () =>
			parseCrewManifest(
				{ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] },
				"/root-B/.pi/bebop/crew.json",
			),
		claimEndpoint: (async () => {
			claims += 1;
			return { idempotent: false };
		}) as never,
	});
	for (const target of [
		"/root-B/.pi/other/sockets/dev.sock",
		"/root-B/.pi/bebop/member.sock",
		"/root-B/.pi/bebop/sockets/../dev.sock",
		"/root-B/.pi/bebop/sockets/unknown.sock",
	]) {
		assert.equal(
			await maybeHandleStartupSocketJoin(
				context({ cwd: "/root-A" }),
				piWithFlag(target),
				{ socket: "crew-socket" },
				runtime,
				"/tmp/global.sock",
			),
			false,
		);
	}
	assert.equal(claims, 0);
});

test("startup revalidates supported membership with the current global socket", async () => {
	const globalSockets: string[] = [];
	const runtime = {
		join: async (request: { globalSocketPath: string }) => {
			globalSockets.push(request.globalSocketPath);
			return {
				ok: true,
				idempotent: globalSockets.length > 1,
				membership: {
					member: { name: "dev", role: "developer" },
					socketPath: "/project/.pi/bebop/sockets/dev.sock",
				},
			};
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const startupContext = context();
	const pi = piWithFlag(".pi/bebop/sockets/dev.sock");
	assert.equal(
		await maybeHandleStartupSocketJoin(
			startupContext,
			pi,
			{ socket: "crew-socket" },
			runtime,
			"/tmp/global-first.sock",
		),
		true,
	);
	assert.equal(
		await maybeHandleStartupSocketJoin(
			startupContext,
			pi,
			{ socket: "crew-socket" },
			runtime,
			"/tmp/global-second.sock",
		),
		true,
	);
	assert.deepEqual(globalSockets, ["/tmp/global-first.sock", "/tmp/global-second.sock"]);
});

test("untrusted or failed startup selection is explicit and does not create membership", async () => {
	let joins = 0;
	const runtime = {
		join: async () => {
			joins += 1;
			return { ok: false, error: new Error("occupied endpoint") };
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const untrusted = await maybeHandleStartupSocketJoin(
		context({ isProjectTrusted: () => false, hasUI: false }),
		piWithFlag(".pi/bebop/sockets/dev.sock"),
		{ socket: "crew-socket" },
		runtime,
		"/tmp/global.sock",
	);
	assert.equal(untrusted, false);
	assert.equal(joins, 0);
	const failed = await maybeHandleStartupSocketJoin(
		context(),
		piWithFlag(".pi/bebop/sockets/dev.sock"),
		{ socket: "crew-socket" },
		runtime,
		"/tmp/global.sock",
	);
	assert.equal(failed, false);
	assert.equal(joins, 1);
});
