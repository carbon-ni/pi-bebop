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
	startupRoleSelectionDescriptor,
	membershipJoinErrorDescriptor,
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

function piWithFlag(value: unknown, sendMessages?: { count: number }): ExtensionAPI {
	return {
		getFlag: () => value,
		sendMessage: () => {
			if (sendMessages) sendMessages.count++;
		},
	} as unknown as ExtensionAPI;
}

async function captureStartupBoundary(
	hasUI: boolean,
	resolver: (ctx: ExtensionContext, pi: ExtensionAPI) => Promise<boolean>,
) {
	const notices: string[] = [];
	const errors: string[] = [];
	const sends = { count: 0 };
	const originalError = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	try {
		const ctx = context({ hasUI, ui: { notify: (message: string) => notices.push(message) } });
		const pi = piWithFlag("developer", sends);
		await resolver(ctx, pi);
		return { message: hasUI ? (notices.at(-1) ?? "") : (errors.at(-1) ?? ""), notices, errors, sends };
	} finally {
		console.error = originalError;
	}
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
	assert.doesNotMatch(notices[0]!, /Ghost|manifest path|private\/tmp/);
	assert.match(notices[0]!, /Next: verify startup configuration and retry/);
	assert.match(notices[0]!, /\(code: unexpected-failure\)$/);
});

test("startup role selection preserves known codes and bounded role choices", async () => {
	const notices: string[] = [];
	let joins = 0;
	const runtime = {
		join: async () => {
			joins += 1;
			return { ok: true, idempotent: false, membership: undefined };
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const handled = await maybeHandleStartupRoleJoin(
		context({ ui: { notify: (message: string) => notices.push(message) } }),
		piWithFlag("product"),
		{ role: "crew-role" },
		runtime,
		"/tmp/global.sock",
		async () => ({
			ok: false,
			code: "unknown-role",
			role: "product",
			availableRoles: ["Mary", "Kelly"],
		}),
	);
	assert.equal(handled, false);
	assert.equal(joins, 0);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /^Crew startup role join failed:/);
	assert.match(notices[0]!, /\(code: unknown-role\)$/);
	assert.match(notices[0]!, /Location: --crew-role="product"/);
	assert.deepEqual(
		startupRoleSelectionDescriptor({
			ok: false,
			code: "unknown-role",
			role: "product",
			availableRoles: ["Mary", "Kelly"],
		}),
		{
			code: "unknown-role",
			operation: "Crew startup role join",
			reason: "the configured role is not present in the Crew manifest",
			recovery: ["choose one of the listed exact roles, then retry."],
			location: { kind: "flag", name: "--crew-role", value: "product" },
			validChoices: ["Mary", "Kelly"],
		},
	);
});

test("startup role boundary keeps UI/headless known and unknown failures identical and turn-free", async () => {
	const runtime = {
		join: async () => {
			throw new Error("must not join");
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	const cases = [
		{
			expectedCode: "unknown-role",
			resolver: async () => ({
				ok: false as const,
				code: "unknown-role" as const,
				role: "developer",
				availableRoles: ["Mary"],
			}),
		},
		{
			expectedCode: "unexpected-failure",
			resolver: async () => {
				throw new Error("private/tmp/startup-secret");
			},
		},
	];
	for (const item of cases) {
		const invoke = (ctx: ExtensionContext, pi: ExtensionAPI) =>
			maybeHandleStartupRoleJoin(ctx, pi, { role: "crew-role" }, runtime, "/tmp/global.sock", item.resolver);
		const ui = await captureStartupBoundary(true, invoke);
		const headless = await captureStartupBoundary(false, invoke);
		assert.equal(ui.message, headless.message);
		assert.equal(ui.notices.length, 1);
		assert.equal(ui.errors.length, 0);
		assert.equal(headless.notices.length, 0);
		assert.equal(headless.errors.length, 1);
		assert.equal(ui.sends.count, 0);
		assert.equal(headless.sends.count, 0);
		assert.match(ui.message, new RegExp(`\\(code: ${item.expectedCode}\\)$`));
		assert.doesNotMatch(ui.message, /private\/tmp|startup-secret/);
	}
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

test("startup role resolver failures stay generic and do not leak exception text", async () => {
	const notices: string[] = [];
	const handled = await maybeHandleStartupRoleJoin(
		context({ ui: { notify: (message: string) => notices.push(message) } }),
		piWithFlag("developer"),
		{ role: "crew-role" },
		{
			join: async () => ({ ok: true, idempotent: false, membership: undefined }),
			leave: async () => ({ ok: true, left: false }),
			getMembership: () => null,
		} as unknown as MembershipRuntime,
		"/tmp/global.sock",
		async () => {
			throw new Error("private/tmp/resolver-secret");
		},
	);
	assert.equal(handled, false);
	assert.match(notices[0]!, /\(code: unexpected-failure\)$/);
	assert.doesNotMatch(notices[0]!, /private\/tmp|resolver-secret/);
});

test("startup membership error mapping preserves known codes and genericizes unknown codes", () => {
	for (const code of [
		"manifest-load-failed",
		"member-not-found",
		"claim-failed",
		"switch-release-failed",
		"rollback-failed",
	] as const) {
		const descriptor = membershipJoinErrorDescriptor(code, "Crew startup join");
		assert.equal(descriptor.code, code);
		assert.doesNotMatch(descriptor.reason, /private\/tmp|secret|token/i);
	}
	assert.equal(membershipJoinErrorDescriptor("forged-code", "Crew startup join").code, "unexpected-failure");
});

test("public startup socket and role joins preserve claim-failed from the membership adapter", async () => {
	const manifest = parseCrewManifest(
		{ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] },
		"/project/.pi/bebop/crew.json",
	);
	const failingRuntime = (): MembershipRuntime =>
		createMembershipRuntime({
			loadManifest: async () => manifest,
			claimEndpoint: async () => {
				throw new Error("private/tmp/claim-secret");
			},
		});
	for (const [label, handler] of [
		[
			"socket",
			(runtime: MembershipRuntime, notices: string[]) =>
				maybeHandleStartupSocketJoin(
					context({ ui: { notify: (message: string) => notices.push(message) } }),
					piWithFlag(".pi/bebop/sockets/dev.sock"),
					{ socket: "crew-socket" },
					runtime,
					"/tmp/global.sock",
				),
		],
		[
			"role",
			(runtime: MembershipRuntime, notices: string[]) =>
				maybeHandleStartupRoleJoin(
					context({ ui: { notify: (message: string) => notices.push(message) } }),
					piWithFlag("developer"),
					{ role: "crew-role" },
					runtime,
					"/tmp/global.sock",
					async () => ({
						ok: true,
						manifestPath: "/project/.pi/bebop/crew.json",
						socketPath: "/project/.pi/bebop/sockets/dev.sock",
					}),
				),
		],
	] as const) {
		const notices: string[] = [];
		assert.equal(await handler(failingRuntime(), notices), false, `${label} join should fail`);
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /\(code: claim-failed\)$/);
		assert.doesNotMatch(notices[0]!, /private\/tmp|claim-secret/);
	}
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
	const failureNotices: string[] = [];
	const failed = await maybeHandleStartupSocketJoin(
		context({ ui: { notify: (message: string) => failureNotices.push(message) } }),
		piWithFlag(".pi/bebop/sockets/dev.sock"),
		{ socket: "crew-socket" },
		runtime,
		"/tmp/global.sock",
	);
	assert.equal(failed, false);
	assert.equal(joins, 1);
	assert.equal(failureNotices.length, 1);
	assert.doesNotMatch(failureNotices[0]!, /occupied endpoint|private\/tmp/);
	assert.match(failureNotices[0]!, /\(code: unexpected-failure\)$/);
});
