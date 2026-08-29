import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	normalizeIdleErrorCode,
	registerWaitForMemberIdleTool,
	type MemberIdleWaitToolTransport,
} from "./wait-for-member-idle.ts";
import { createSocketState } from "../pi/control-runtime.ts";

type RegisteredTool = {
	name: string;
	parameters: unknown;
	description: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details: unknown;
		terminate?: boolean;
	}>;
};

/** Deterministic flush of the microtask/macrotask queues (no wall-clock sleep). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(membership: unknown | (() => unknown), transport: Partial<MemberIdleWaitToolTransport> = {}) {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	const getMembership = typeof membership === "function" ? (membership as () => unknown) : () => membership;
	const state = createSocketState();
	state.membershipRuntime = { getMembership } as never;
	state.context = { isProjectTrusted: () => true } as never;
	const probes: Array<string | null> = [];
	const defaultTransport: MemberIdleWaitToolTransport = {
		probeEndpoint: async () => {
			probes.push(state.blockingWait?.activeMarker()?.kind ?? null);
			return true;
		},
		requestIdleWait: async () => ({
			ok: true,
			result: {
				member: { name: "Bob", role: "dev" },
				outcome: "idle",
				disposition: "became-idle",
				observedAt: "2026-08-23T12:03:00.000Z",
			},
		}),
	};
	registerWaitForMemberIdleTool(pi, state, { ...defaultTransport, ...transport });
	assert.ok(registeredTool);
	return { tool: registeredTool!, state, probes };
}

const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	socketPath: "/project/.pi/bebop/sockets/Tony.sock",
	member: {
		name: "Tony",
		role: "lead",
		socket: "sockets/Tony.sock",
		socketPath: "/project/.pi/bebop/sockets/Tony.sock",
	},
	manifest: {
		version: 1,
		presence: { notifications: true },
		members: [
			{
				name: "Tony",
				role: "lead",
				socket: "sockets/Tony.sock",
				socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			},
			{
				name: "Bob",
				role: "dev",
				socket: "sockets/Bob.sock",
				socketPath: "/project/.pi/bebop/sockets/Bob.sock",
			},
			{
				name: "Dave",
				role: "dev",
				socket: "sockets/Dave.sock",
				socketPath: "/project/.pi/bebop/sockets/Dave.sock",
			},
		],
	},
};

describe("wait_for_member_idle tool (TASK-0081 blocking)", () => {
	test("normalizes unknown transport codes safely", () => {
		for (const code of [
			"untrusted",
			"unknown-member",
			"ambiguous-member",
			"self-wait",
			"not-a-member",
			"remote-rejected",
			"capacity-exceeded",
		]) {
			assert.equal(normalizeIdleErrorCode(code), code);
		}
		assert.equal(normalizeIdleErrorCode("offline"), "offline");
		assert.equal(normalizeIdleErrorCode("password-secret"), "unexpected-failure");
	});
	test("registers with only member and optional bounded timeout_seconds and the exact public wording", () => {
		const { tool } = setup(membership);
		assert.equal(tool.name, "wait_for_member_idle");
		const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
		assert.deepEqual(Object.keys(properties), ["member", "timeout_seconds"]);
		const timeout = properties.timeout_seconds as { minimum?: number; maximum?: number };
		assert.equal(timeout.minimum, 60);
		assert.equal(timeout.maximum, 7200);
		assert.match(tool.description, /Block this run until/);
		assert.match(tool.description, /accepted message releases the idle wait/);
		assert.match(tool.description, /Only one blocking Member Idle Wait may be active locally/);
		assert.match(tool.description, /bounded timeout is always armed/);
		assert.match(tool.description, /1,800 seconds/);
		assert.doesNotMatch(tool.description, /yield/);
	});

	test("unjoined execution resolves to a not-joined error before any probe", async () => {
		let probed = 0;
		const { tool } = setup(() => null, { probeEndpoint: async () => ((probed += 1), true) });
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, true);
		const details = result.details as { error: string; actionableError: { code: string; message: string } };
		assert.equal(details.error, "not-joined");
		assert.equal(details.actionableError.code, details.error);
		assert.equal(result.content[0]?.text, details.actionableError.message);
		assert.doesNotMatch(JSON.stringify(result.details), /Error:|stack|private\.sock/i);
		assert.equal(probed, 0);
	});

	test("configured offline target returns compact offline result without requesting", async () => {
		let requests = 0;
		const { tool } = setup(membership, {
			probeEndpoint: async () => false,
			requestIdleWait: async () => {
				requests += 1;
				return { ok: true, result: {} as never };
			},
		});
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, false);
		assert.match(result.content[0]!.text, /offline/);
		assert.equal(requests, 0);
	});

	test("TASK-0081: reachable busy target BLOCKS the run and returns the terminal became-idle result directly (no yield)", async () => {
		const { tool } = setup(membership);
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, undefined);
		assert.equal(result.details.yielded, undefined, "blocking tool must not yield");
		assert.equal(result.terminate, false);
		const terminal = result.details.result as { outcome: string };
		assert.equal(terminal.outcome, "idle");
		assert.match(result.content[0]!.text, /became-idle/);
	});

	test("TASK-0081: already-idle, offline, and timeout outcomes return directly as terminal results", async () => {
		const already = setup(membership, {
			requestIdleWait: async () => ({
				ok: true,
				result: {
					member: { name: "Bob", role: "dev" },
					outcome: "idle",
					disposition: "already-idle",
					observedAt: "2026-08-23T12:03:00.000Z",
				},
			}),
		});
		const alreadyResult = await already.tool.execute("id", { member: "Bob" });
		assert.match(alreadyResult.content[0]!.text, /already-idle/);

		const timedOut = setup(membership, {
			requestIdleWait: async () => ({ ok: false, code: "timeout" }),
		});
		const timeoutResult = await timedOut.tool.execute("id", { member: "Bob" });
		assert.match(timeoutResult.content[0]!.text, /timeout/);

		const offline = setup(membership, {
			requestIdleWait: async () => ({
				ok: true,
				result: {
					member: { name: "Bob", role: "dev" },
					outcome: "offline",
					observedAt: "2026-08-23T12:03:00.000Z",
				},
			}),
		});
		const offlineResult = await offline.tool.execute("id", { member: "Bob" });
		assert.match(offlineResult.content[0]!.text, /offline/);
	});

	test("TASK-0081: an accepted Bebop message releases the blocked wait with message-received and cancels the remote subscription", async () => {
		let aborted = false;
		let pendingResolve: ((value: never) => void) | undefined;
		const { tool, state } = setup(membership, {
			requestIdleWait: async (_endpoint, _label, { signal }) => {
				if (signal)
					signal.addEventListener("abort", () => {
						aborted = true;
						pendingResolve?.({
							ok: false,
							code: "aborted",
						} as never);
					});
				return new Promise((resolve) => {
					pendingResolve = resolve as (value: never) => void;
				});
			},
		});
		const pending = tool.execute("id", { member: "Bob" });
		await flush();
		// The wait is armed and blocking; a Bebop model delivery claims it.
		assert.equal(state.wakeGate.notifyAccepted("delivery-1"), true, "armed listener claims the accepted message");
		const result = await pending;
		await flush();
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true, "message wake must terminate the content-free continuation");
		assert.equal((result.details.result as { outcome: string }).outcome, "message-received");
		assert.match(result.content[0]!.text, /message-received/);
		assert.equal(aborted, true, "remote idle subscription cancelled on message wake");
		// The claimed listener is consumed: a later message no longer wakes.
		assert.equal(state.wakeGate.notifyAccepted("delivery-2"), false);
	});

	test("TASK-0081: terminal outcome releases the listener and aborts the subscription", async () => {
		let aborted = false;
		const { tool, state } = setup(membership, {
			requestIdleWait: async (_endpoint, _label, { signal }) => {
				if (signal)
					signal.addEventListener("abort", () => {
						aborted = true;
					});
				return {
					ok: true,
					result: {
						member: { name: "Bob", role: "dev" },
						outcome: "idle",
						disposition: "became-idle",
						observedAt: "2026-08-23T12:03:00.000Z",
					},
				};
			},
		});
		const result = await tool.execute("id", { member: "Bob" });
		await flush();
		assert.equal(result.isError, undefined);
		assert.equal(state.wakeGate.notifyAccepted("delivery-x"), false, "no lingering listener after terminal");
		assert.equal(aborted, true, "subscription aborted after terminal");
	});

	test("TASK-0081: a message accepted BEFORE arm does not wake the new wait (pre-arm outside wake scope)", async () => {
		const { tool, state } = setup(membership);
		// Accepted before the wait arms: no listener exists, message keeps its mode.
		assert.equal(state.wakeGate.notifyAccepted("delivery-0"), false);
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(
			(result.details.result as { outcome: string }).outcome,
			"idle",
			"wait resolves on its own terminal",
		);
	});

	test("TASK-0081: a second concurrent local wait fails wait-in-progress before IO", async () => {
		let probes = 0;
		let requests = 0;
		const { tool, state } = setup(membership, {
			probeEndpoint: async () => {
				probes += 1;
				return true;
			},
			requestIdleWait: async () => {
				requests += 1;
				return new Promise<never>(() => undefined);
			},
		});
		const first = tool.execute("id", { member: "Bob" });
		await flush();
		assert.equal(state.wakeGate.armed, true, "first wait armed synchronously");
		const second = await tool.execute("id", { member: "Dave" });
		assert.equal(second.isError, true);
		assert.equal((second.details as { error?: string }).error, "wait-in-progress");
		assert.equal(probes, 1, "second call fails before the reachability probe");
		assert.equal(requests, 1, "second call never opens a subscription");
		// Release the first wait via an accepted message; then a new wait may start.
		assert.equal(
			state.wakeGate.notifyAccepted("delivery-1"),
			true,
			"first wait still armed and claims the message",
		);
		await first;
		assert.equal(state.wakeGate.armed, false, "slot free after terminal cleanup");
		assert.deepEqual(
			state.wakeGate.arm(() => undefined),
			{ ok: true },
			"slot reusable after cleanup",
		);
		assert.equal(state.wakeGate.notifyAccepted("delivery-2"), true);
	});

	test("TASK-0121: slash member-idle capacity rejects the peer wait without public marker IO", async () => {
		let probes = 0;
		const { tool, state } = setup(membership, {
			probeEndpoint: async () => {
				probes += 1;
				return true;
			},
		});
		const lease = state.crewIdleCapacity.acquire("member-idle-tool");
		assert.ok(lease);
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, true);
		assert.equal((result.details as { error?: string }).error, "wait-in-progress");
		assert.equal(probes, 0, "peer wait rejects before endpoint IO");
		assert.equal(state.blockingWait.activeMarker(), null, "slash capacity has no public wait marker");
		lease.release();
	});

	test("TASK-0081: requester abort is a terminal before IO and cancels the subscription", async () => {
		let aborted = false;
		const controller = new AbortController();
		const { tool, state } = setup(membership, {
			requestIdleWait: async (_endpoint, _label, { signal }) => {
				if (signal)
					signal.addEventListener("abort", () => {
						aborted = true;
					});
				return new Promise<never>(() => undefined);
			},
		});
		const pending = tool.execute("id", { member: "Bob" }, controller.signal);
		await flush();
		controller.abort();
		const result = await pending;
		assert.equal(result.isError, true);
		assert.equal((result.details as { error?: string }).error, "aborted");
		assert.equal(aborted, true);
		assert.equal(state.wakeGate.notifyAccepted("delivery-x"), false, "no lingering listener after abort");
	});

	test("TASK-0081: malformed and transport failures resolve as honest errors, never hang", async () => {
		const malformed = setup(membership, {
			requestIdleWait: async () => ({ ok: false, code: "malformed-response" }),
		});
		const malformedResult = await malformed.tool.execute("id", { member: "Bob" });
		assert.equal(malformedResult.isError, true);
		assert.equal((malformedResult.details as { error?: string }).error, "malformed-response");
	});

	test("TASK-0121: rejected reachability probe releases every local wait owner", async () => {
		const { tool, state } = setup(membership, {
			probeEndpoint: async () => {
				throw new Error("probe failed");
			},
		});
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, true);
		assert.equal((result.details as { error?: string }).error, "transport-error");
		assert.equal(state.wakeGate.armed, false);
		assert.equal(state.blockingWait.activeMarker(), null);
		const lease = state.crewIdleCapacity.acquire("member-idle-tool");
		assert.ok(lease, "capacity is reusable after probe failure");
		lease.release();
	});

	test("runtime unknown transport code is genericized in content and details", async () => {
		const { tool } = setup(membership, {
			requestIdleWait: async () => ({ ok: false, code: "password-secret" as never }),
		});
		const result = await tool.execute("id", { member: "Bob" });
		const details = result.details as { error: string; actionableError: { code: string; message: string } };
		assert.equal(details.error, "unexpected-failure");
		assert.equal(details.actionableError.code, "unexpected-failure");
		assert.equal(result.content[0]?.text, details.actionableError.message);
		assert.doesNotMatch(JSON.stringify(result), /password-secret/i);
	});

	test("TASK-0117: marker kind member-idle is acquired before target IO and released exactly once per terminal", async () => {
		const { tool, state, probes } = setup(membership, {
			requestIdleWait: () => new Promise(() => undefined),
		});
		const pending = tool.execute("id", { member: "Bob" });
		await flush();
		// Acquired BEFORE the reachability probe observed it.
		assert.deepEqual(probes, ["member-idle"]);
		assert.equal(state.blockingWait.activeMarker()?.kind, "member-idle");
		const seen: Array<string | null> = [];
		state.blockingWait.subscribeOnce((marker) => seen.push(marker ? marker.kind : null));
		// Unblock via a local accepted-message wake (TASK-0081 path).
		state.wakeGate.notifyAccepted("delivery-x");
		const result = await pending;
		assert.equal(result.isError, undefined);
		assert.equal((result.details as { result: { outcome: string } }).result.outcome, "message-received");
		assert.deepEqual(state.blockingWait.activeMarker(), null, "released exactly once");
		assert.deepEqual(seen, [null], "release transition observed exactly once");
	});

	test("TASK-0117: every terminal path releases the marker (offline, timeout, error, abort)", async () => {
		const cases: Array<[string, Partial<MemberIdleWaitToolTransport>]> = [
			[
				"offline",
				{
					probeEndpoint: async () => false,
				},
			],
			[
				"timeout",
				{
					requestIdleWait: async () => ({ ok: false as const, code: "timeout" as const }),
				},
			],
			[
				"transport-error",
				{
					requestIdleWait: async () => {
						throw new Error("boom");
					},
				},
			],
		];
		for (const [label, transportOverride] of cases) {
			const { tool, state } = setup(membership, transportOverride);
			const result = await tool.execute("id", { member: "Bob" });
			void result;
			await flush();
			assert.deepEqual(state.blockingWait.activeMarker(), null, label);
		}
		const { tool: abortTool, state: abortState } = setup(membership, {
			requestIdleWait: () => new Promise(() => undefined),
		});
		const controller = new AbortController();
		const aborting = abortTool.execute("id", { member: "Bob" }, controller.signal);
		await flush();
		assert.equal(abortState.blockingWait.activeMarker()?.kind, "member-idle");
		controller.abort();
		await aborting;
		assert.deepEqual(abortState.blockingWait.activeMarker(), null, "aborted");
	});

	test("TASK-0117: the single local slot rejects any second blocking wait kind before remote IO", async () => {
		const { tool, state } = setup(membership, {
			requestIdleWait: () => new Promise(() => undefined),
		});
		const first = tool.execute("id", { member: "Bob" });
		await flush();
		assert.equal(state.blockingWait.acquire("crew-idle").ok, false);
		state.wakeGate.notifyAccepted("delivery-y");
		await first;
		assert.deepEqual(state.blockingWait.activeMarker(), null);
	});

	test("timeout_seconds is validated (out of range rejected deterministically before IO)", async () => {
		const { tool } = setup(membership);
		const low = await tool.execute("id", { member: "Bob", timeout_seconds: 59 });
		assert.equal(low.isError, true);
		assert.equal((low.details as { error?: string }).error, "invalid-timeout");
		const high = await tool.execute("id", { member: "Bob", timeout_seconds: 7201 });
		assert.equal(high.isError, true);
		assert.equal((high.details as { error?: string }).error, "invalid-timeout");
	});
});
