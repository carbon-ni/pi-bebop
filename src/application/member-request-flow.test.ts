import assert from "node:assert/strict";
import test from "node:test";
import { MemberRequestFlow } from "./member-request-flow.ts";
import type { MemberRequestFlowDependencies, MemberRequestResponseChannel } from "./member-request-flow.ts";
import { parseCrewManifest } from "../domain/index.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";

const manifest = parseCrewManifest(
	{
		version: 1,
		members: [
			{ name: "dev", role: "developer", socket: "sockets/dev.sock" },
			{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
		],
	},
	"/project/.pi/bebop/crew.json",
);
const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	manifest,
	member: { ...manifest.members[0], socketPath: "/project/.pi/bebop/sockets/dev.sock" },
	socketPath: "/project/.pi/bebop/sockets/dev.sock",
	globalSocketPath: "/project/global.sock",
};
function setup(overrides: Partial<MemberRequestFlowDependencies> = {}) {
	let callback: ((update: any) => void) | undefined;
	const dependencies: MemberRequestFlowDependencies = {
		resolveEndpoint: async (socketPath) => socketPath,
		transport: {
			open: async (_endpoint, _command, options) => {
				callback = options.onUpdate;
				return { close: () => undefined };
			},
			respond: async (_channel, _update) => undefined,
		},
		now: () => 1_000,
		createRequestId: () => "request-1",
		setTimeout: (() => undefined) as unknown as MemberRequestFlowDependencies["setTimeout"],
		clearTimeout: (() => undefined) as unknown as MemberRequestFlowDependencies["clearTimeout"],
		...overrides,
	};
	return { flow: new MemberRequestFlow(dependencies), emit: (update: any) => callback?.(update) };
}

test("request registers before endpoint/open and returns accepted without waiting for response", async () => {
	const events: string[] = [];
	const { flow } = setup({
		resolveEndpoint: async (socketPath) => {
			events.push(`resolve:${socketPath}`);
			assert.equal(flow.registry.outboundCount(), 1);
			return socketPath;
		},
		transport: {
			open: async (_endpoint, command, options) => {
				events.push(`open:${command.requestId}`);
				assert.equal(flow.registry.outboundCount(), 1);
				options.onUpdate;
				return { close: () => undefined };
			},
			respond: async () => undefined,
		},
	});
	const accepted = await flow.sendMemberRequest({ membership, member: "qa", message: "Review" });
	assert.deepEqual(accepted.member, membership.manifest.members[1]);
	assert.deepEqual(events, ["resolve:/project/.pi/bebop/sockets/qa.sock", "open:request-1"]);
	// Close the accepted request channel so this test does not leave its 300s lifecycle timer active.
	assert.equal(flow.registry.resolveOffline("request-1").ok, true);
});

test("pre-accept failure cleans request while lost acknowledgement closes as outcome-unknown", async () => {
	const failed = setup({
		transport: {
			open: async () => {
				throw new Error("offline");
			},
			respond: async () => undefined,
		},
	});
	await assert.rejects(
		() => failed.flow.sendMemberRequest({ membership, member: "qa", message: "Review" }),
		/offline/,
	);
	assert.equal(failed.flow.registry.outboundCount(), 0);
	const lost = setup({
		transport: {
			open: async () => {
				throw new RpcProtocolError("outcome-unknown", "lost");
			},
			respond: async () => undefined,
		},
	});
	await assert.rejects(
		() => lost.flow.sendMemberRequest({ membership, member: "qa", message: "Review" }),
		/outcome-unknown/,
	);
	assert.equal(lost.flow.registry.outboundCount(), 0);
});

test("terminal response is buffered exactly once and wait returns it", async () => {
	const setupResult = setup();
	await setupResult.flow.sendMemberRequest({ membership, member: "qa", message: "Review" });
	setupResult.emit({
		kind: "response",
		requestId: "request-1",
		member: { name: "qa", role: "reviewer" },
		message: "Done",
		instructions: [],
	});
	let update: unknown;
	const waited = setupResult.flow.waitForRequestOutcome((value) => {
		update = value;
	});
	assert.equal(waited.ok, true);
	if (waited.ok) assert.equal(waited.kind, "update");
	assert.deepEqual(update, undefined);
	const second = setupResult.flow.waitForRequestOutcome(() => undefined);
	assert.deepEqual(second, { ok: false, code: "no-pending-requests" });
});

test("inbound responder selection is zero/one/multiple and sends only through active channel", async () => {
	const sent: unknown[] = [];
	const setupResult = setup({
		transport: {
			open: async () => ({ close: () => undefined }),
			respond: async (_channel, update) => sent.push(update),
		},
	});
	await assert.rejects(
		() => setupResult.flow.respondToMemberRequest({ member: { name: "dev", role: "developer" }, message: "x" }),
		/no-pending-request/,
	);
	const channel: MemberRequestResponseChannel = { send: async (update) => sent.push(update) };
	setupResult.flow.registerInboundRequest({
		requestId: "in-1",
		requester: { name: "dev", role: "developer" },
		message: "x",
		instructions: [],
		channel,
	});
	setupResult.flow.registerInboundRequest({
		requestId: "in-2",
		requester: { name: "lead", role: "lead" },
		message: "y",
		instructions: [],
		channel,
	});
	await assert.rejects(
		() =>
			setupResult.flow.respondToMemberRequest({ member: { name: "qa", role: "reviewer" }, message: "response" }),
		(error: unknown) => error instanceof Error && /ambiguous-request.*in-1.*in-2/.test(error.message),
	);
	setupResult.flow.acceptInboundRequest("in-1");
	setupResult.flow.removeInboundRequest("in-2");
	await setupResult.flow.respondToMemberRequest({ member: { name: "qa", role: "reviewer" }, message: "response" });
	assert.equal(sent.length, 1);
	await assert.rejects(
		() => setupResult.flow.respondToMemberRequest({ member: { name: "qa", role: "reviewer" }, message: "replay" }),
		/no-pending-request/,
	);
});
