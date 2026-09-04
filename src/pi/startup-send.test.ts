import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMembershipRuntime, type MembershipRuntime } from "../infra/membership-runtime.ts";
import { createGuestMembershipRuntime, type GuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import { parseCrewManifest } from "../domain/index.ts";
import {
	maybeHandleStartupGuestJoins,
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
		sessionManager: { getSessionId: () => "startup-session" },
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
describe("guest startup joins", () => {
	async function memberServer(root: string, name: string, status: "pending" | "approved" = "pending") {
		const { createRpcServer, closeRpcServer, writeResponse } = await import("../infra/rpc-server.ts");
		const socketPath = path.join(root, `${name}.sock`);
		let requests = 0;
		const server = await createRpcServer(socketPath, (command, socket) => {
			if (command.type !== "guest_join") return;
			requests += 1;
			writeResponse(socket, {
				type: "response",
				command: "guest_join",
				success: true,
				id: command.id,
				data: {
					status,
					requestId: `${name}-request-1`,
					crew: { id: name, displayName: name.toUpperCase() },
				},
			});
		});
		return { socketPath, close: () => closeRpcServer(server), requestCount: () => requests };
	}

	function guestFlags(flags: Record<string, unknown>): ExtensionAPI {
		return { getFlag: (name: string) => flags[name] } as unknown as ExtensionAPI;
	}

	function guestRuntime(): GuestMembershipRuntime {
		return createGuestMembershipRuntime({
			guestIdentity: "startup-guest-session",
			callbackEndpoint: "/tmp/startup-callback.sock",
			createRequestId: () => "local-1",
			submitJoinRequest: async () => undefined,
		});
	}

	function notifyingContext(trusted = true) {
		const notifications: string[] = [];
		const ctx = context({
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
			isProjectTrusted: () => trusted,
		});
		return { ctx, notifications };
	}

	test("returns no outcomes when no guest flags are present", async () => {
		const results = await maybeHandleStartupGuestJoins(
			context(),
			guestFlags({}),
			guestRuntime(),
			"/tmp/callback.sock",
		);
		assert.deepEqual(results, []);
	});

	test("missing --guest-as or --guest-join fails before sending any request", async () => {
		const { ctx, notifications } = notifyingContext();
		const dead = path.join(os.tmpdir(), `missing-flag-${process.pid}.sock`);
		const results = await maybeHandleStartupGuestJoins(
			ctx,
			guestFlags({ "guest-join": dead }),
			guestRuntime(),
			"/tmp/callback.sock",
		);
		assert.deepEqual(results, [
			{
				target: dead,
				ok: false,
				error: "Guest startup requires --guest-as <name> and at least one --guest-join <socket>.",
			},
		]);
		assert.equal(notifications.length, 1);

		const noTargets = await maybeHandleStartupGuestJoins(
			ctx,
			guestFlags({ "guest-as": "Alex" }),
			guestRuntime(),
			"/tmp/callback.sock",
		);
		assert.deepEqual(noTargets, []);
		assert.equal(notifications.length, 2);
	});

	test("duplicate --guest-join targets reject the whole startup before sending", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-startup-"));
		try {
			const crew = await memberServer(root, "dup-crew");
			try {
				const { ctx, notifications } = notifyingContext();
				const runtime = guestRuntime();
				const results = await maybeHandleStartupGuestJoins(
					ctx,
					guestFlags({ "guest-as": "Alex", "guest-join": [crew.socketPath, crew.socketPath] }),
					runtime,
					"/tmp/callback.sock",
				);
				assert.ok(
					results.every((result) => !result.ok),
					"every duplicate outcome fails",
				);
				assert.ok(results.every((result) => (result.error ?? "").includes("duplicate")));
				assert.equal(crew.requestCount(), 0, "no wire request may precede validation");
				assert.deepEqual(runtime.list(), []);
				assert.match(notifications[0] ?? "", /duplicate/);
			} finally {
				await crew.close();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("untrusted projects reject guest startup before sending any request", async () => {
		const { ctx, notifications } = notifyingContext(false);
		const runtime = guestRuntime();
		const results = await maybeHandleStartupGuestJoins(
			ctx,
			guestFlags({ "guest-as": "Alex", "guest-join": ["/tmp/whatever.sock"] }),
			runtime,
			"/tmp/callback.sock",
		);
		assert.ok(results.every((result) => !result.ok));
		assert.ok(results.every((result) => (result.error ?? "").includes("trusted")));
		assert.deepEqual(runtime.list(), []);
		assert.match(notifications[0] ?? "", /trusted/);
	});

	test("one unavailable crew does not roll back successful bindings to other crews", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-startup-"));
		try {
			const alpha = await memberServer(root, "alpha");
			const beta = await memberServer(root, "beta", "approved");
			const dead = path.join(root, "dead.sock");
			try {
				const runtime = guestRuntime();
				const results = await maybeHandleStartupGuestJoins(
					context(),
					guestFlags({ "guest-as": "Alex", "guest-join": [alpha.socketPath, dead, beta.socketPath] }),
					runtime,
					"/tmp/callback.sock",
				);
				assert.deepEqual(
					results.map((result) => [
						result.target === dead ? "dead" : result.target,
						result.ok,
						result.status,
					]),
					[
						[alpha.socketPath, true, "pending"],
						["dead", false, undefined],
						[beta.socketPath, true, "approved"],
					],
				);
				assert.equal(alpha.requestCount(), 1);
				assert.deepEqual(
					runtime.list().map((row) => [row.crew.id, row.status]),
					[
						["alpha", "pending"],
						["beta", "approved"],
					],
				);
			} finally {
				await alpha.close();
				await beta.close();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
