import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { createSocketState, handleCommand } from "../pi/control-runtime.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createMemberMessageCoordinator } from "../application/member-message.ts";
import { registerMemberIntentTool } from "../tools/member-tool-adapter.ts";
import {
	defaultMemberMessageCliDependencies,
	runMemberMessageCommand,
	type MemberMessageCliDependencies,
} from "./commands/member-message.ts";
import { writeOutcome } from "./output.ts";
import type { CliContext } from "./context.ts";
import type { SourceResolution } from "./source-session.ts";

/**
 * TASK-0062 real-wire proof: the CLI leaf against two real Unix-socket RPC
 * servers running the real production dispatcher (`createSocketState` +
 * `handleCommand`). The source derives membership/trust from its runtime and
 * runs the shared member-message op; the target's real `send` branch acks the
 * delivery. No mocked dispatcher, handler, or RPC codec.
 */

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

interface SessionPair {
	readonly root: string;
	readonly sourceSocket: string;
	readonly targetSocket: string;
	readonly sourceServer: net.Server;
	readonly targetServer: net.Server;
	readonly targetMessages: Array<{ type: string; content: string }>;
	close(): Promise<void>;
}

async function startSessions(t: test.TestContext): Promise<SessionPair> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-message-"));
	const sourceSocket = path.join(root, "source.sock");
	const targetSocket = path.join(root, "target.sock");
	const targetMessages: Array<{ type: string; content: string }> = [];

	const targetState = createSocketState(() => 5_000);
	targetState.server = {} as never;
	targetState.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: targetSocket,
			member: { name: "Kelly", role: "qa", socketPath: targetSocket },
			manifest: { members: [{ name: "Kelly", role: "qa", socketPath: targetSocket }] },
		}),
	} as never;
	targetState.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "target", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	const targetPi = {
		sendMessage: (customMessage: { content: string }, _options: unknown) => {
			targetMessages.push({ type: "send", content: customMessage.content });
		},
	} as never;
	const targetServer = await createRpcServer(targetSocket, (command, socket) =>
		handleCommand(targetPi, targetState, command, socket),
	);

	const sourceState = createSocketState(() => 1_000);
	sourceState.server = {} as never;
	sourceState.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: sourceSocket,
			member: { name: "Tony", role: "lead", socketPath: sourceSocket },
			manifest: {
				members: [
					{ name: "Tony", role: "lead", socketPath: sourceSocket },
					{ name: "Kelly", role: "qa", socketPath: targetSocket },
				],
			},
		}),
	} as never;
	sourceState.memberMessageDependencies = {
		transport: { send: sendRpcCommand },
		resolveEndpoint: resolveMemberEndpoint,
		coordinator: createMemberMessageCoordinator(),
		now: () => 1_000,
	};
	sourceState.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "source", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	const sourceServer = await createRpcServer(sourceSocket, (command, socket) =>
		handleCommand({} as never, sourceState, command, socket),
	);

	t.after(async () => {
		await closeRpcServer(sourceServer);
		await closeRpcServer(targetServer);
		await fs.rm(root, { recursive: true, force: true });
	});
	return {
		root,
		sourceSocket,
		targetSocket,
		sourceServer,
		targetServer,
		targetMessages,
		close: async () => {
			await closeRpcServer(sourceServer);
			await closeRpcServer(targetServer);
		},
	};
}

function cliDeps(sessions: SessionPair): MemberMessageCliDependencies {
	return {
		...defaultMemberMessageCliDependencies,
		resolveSource: (): SourceResolution & { ok: true } => ({
			ok: true,
			kind: "id",
			idSocketPath: sessions.sourceSocket,
			aliasSocketPath: sessions.sourceSocket,
		}),
	};
}

test("member follow-up and redirect round-trip over real sockets with accepted dispositions", async (t) => {
	const sessions = await startSessions(t);
	const deps = cliDeps(sessions);

	const followUp = await runMemberMessageCommand(
		{
			command: "member-follow-up",
			intent: "follow_up",
			member: "Kelly",
			message: "wrap up",
			instructions: [],
			stdin: false,
			format: "json",
		},
		context(),
		deps,
	);
	assert.equal(followUp.kind, "result");
	if (followUp.kind !== "result") throw new Error("expected result");
	assert.equal(followUp.result.ok, true);
	assert.equal(followUp.result.status, "accepted");
	const followData = followUp.result.data as {
		member: { name: string; role: string };
		deliveryId: string;
		disposition: string;
	};
	assert.equal(followData.member.name, "Kelly");
	assert.equal(followData.member.role, "qa");
	assert.equal(followData.disposition, "queued"); // target busy → follow-up queues
	assert.match(followData.deliveryId, /^delivery-/);
	assert.equal(writeOutcome(new PassThrough(), followUp), 0);

	const redirect = await runMemberMessageCommand(
		{
			command: "member-redirect",
			intent: "redirect",
			member: "Kelly",
			message: "change course",
			instructions: ["careful"],
			stdin: false,
			format: "json",
		},
		context(),
		deps,
	);
	assert.equal(redirect.kind, "result");
	if (redirect.kind !== "result") throw new Error("expected result");
	assert.equal(redirect.result.ok, true);
	const redirectData = redirect.result.data as { deliveryId: string; disposition: string };
	assert.equal(redirectData.disposition, "steered");
	assert.equal(writeOutcome(new PassThrough(), redirect), 0);

	// The target session received exactly two structured messages, in order.
	assert.equal(sessions.targetMessages.length, 2);
	assert.equal(
		sessions.targetMessages[0]!.content,
		"[follow-up] from Tony (lead) · age at delivery 4s\n" +
			"Information only; no correlated Response expected.\n" +
			'{"type":"message-context","content":"wrap up","origin":{"kind":"crew","name":"Tony","role":"lead"}}',
	);
	assert.equal(
		sessions.targetMessages[1]!.content,
		"[redirect] from Tony (lead) · age at delivery 4s\n" +
			"Information only; no correlated Response expected.\n" +
			'{"type":"message-context","content":"change course","instructions":["careful"],"origin":{"kind":"crew","name":"Tony","role":"lead"}}',
	);
});

test("member follow-up maps target offline over the real wire to exit 1 code offline", async (t) => {
	const sessions = await startSessions(t);
	// Only the target goes away; the source stays up and reports target offline.
	await closeRpcServer(sessions.targetServer);
	const deps = cliDeps(sessions);
	const outcome = await runMemberMessageCommand(
		{
			command: "member-follow-up",
			intent: "follow_up",
			member: "Kelly",
			message: "x",
			instructions: [],
			stdin: false,
			format: "json",
		},
		context(),
		deps,
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") throw new Error("expected result");
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error?.code, "offline");
	assert.equal(writeOutcome(new PassThrough(), outcome), 1);
});

test("member follow-up aborts mid-delivery with code aborted when cancelled", async (t) => {
	const sessions = await startSessions(t);
	const deps = cliDeps(sessions);
	const controller = new AbortController();
	const pending = runMemberMessageCommand(
		{
			command: "member-follow-up",
			intent: "follow_up",
			member: "Kelly",
			message: "late",
			instructions: [],
			stdin: false,
			format: "json",
		},
		{ cwd: "/project", input: new PassThrough(), signal: controller.signal },
		deps,
	);
	// Cancel before the source can answer; the CLI reports aborted, never accepted.
	controller.abort();
	const outcome = await pending;
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") throw new Error("expected result");
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error?.code, "aborted");
	assert.equal(writeOutcome(new PassThrough(), outcome), 1);
});

// ---------------------------------------------------------------------------
// Tool-versus-CLI parity: the tool adapter and the CLI-delegated server path
// drive the SAME member-message application operation with the same delivery
// intent, wire command, and disposition semantics.
// ---------------------------------------------------------------------------

test("tool and CLI produce identical wire delivery, disposition, and identity for both intents", async () => {
	// One shared fake transport records the wire commands both surfaces emit.
	const wire: Array<{ delivery: string; content: string }> = [];
	const transport = {
		send: async (_endpoint: string, command: { delivery?: string; payload: { content: string } }) => {
			wire.push({ delivery: command.delivery ?? "follow_up", content: command.payload.content });
			return {
				response: {
					type: "response",
					command: "send",
					success: true,
					id: "request-1",
					data: {
						deliveryId: "delivery-shared",
						disposition: command.delivery === "immediate" ? "steered" : "queued",
					},
				},
			};
		},
	};
	const adapterDependencies = {
		transport,
		resolveEndpoint: async (socketPath: string) => socketPath,
		coordinator: createMemberMessageCoordinator(),
	};

	for (const intent of ["follow_up", "redirect"] as const) {
		wire.length = 0;

		// Tool surface (send_follow_up / redirect_member).
		const toolTools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const toolPi = {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
				toolTools.set(tool.name, tool);
			},
		} as never;
		const toolState = createSocketState();
		toolState.membershipRuntime = {
			getMembership: () => ({
				manifestPath: "/project/.pi/bebop/crew.json",
				socketPath: "/dev.sock",
				member: { name: "dev", role: "developer", socketPath: "/dev.sock" },
				manifest: { members: [{ name: "Kelly", role: "qa", socketPath: "/qa.sock" }] },
			}),
		} as never;
		toolState.context = {
			sessionManager: { getSessionId: () => "s1", getSessionName: () => null },
		} as never;
		registerMemberIntentTool(
			toolPi,
			toolState,
			intent === "follow_up" ? "follow_up" : "immediate",
			adapterDependencies,
		);
		const toolName = intent === "follow_up" ? "send_follow_up" : "redirect_member";
		const toolOutcome = (await toolTools
			.get(toolName)!
			.execute("call", { member: "Kelly", message: "shared msg" }, undefined, undefined, undefined)) as {
			details: { disposition: string; target?: unknown };
			content: Array<{ text: string }>;
		};

		// CLI surface: the CLI leaf sends member_follow_up/member_redirect to a
		// real dispatcher whose handler runs the same op with the same transport.
		wire.length = 0;
		const state = createSocketState();
		state.server = {} as never;
		state.membershipRuntime = {
			getMembership: () => ({
				manifestPath: "/project/.pi/bebop/crew.json",
				socketPath: "/dev.sock",
				member: { name: "dev", role: "developer", socketPath: "/dev.sock" },
				manifest: { members: [{ name: "Kelly", role: "qa", socketPath: "/qa.sock" }] },
			}),
		} as never;
		state.context = {
			hasUI: false,
			sessionManager: { getSessionId: () => "s1", getSessionName: () => null, getEntries: () => [] },
			isIdle: () => false,
			hasPendingMessages: () => false,
			isProjectTrusted: () => true,
		} as never;
		state.memberMessageDependencies = adapterDependencies as never;
		const writes: string[] = [];
		const socket = {
			write: (value: string) => {
				writes.push(value);
				return true;
			},
			once: () => socket,
		} as never;
		await handleCommand(
			{} as never,
			state,
			{
				type: intent === "follow_up" ? "member_follow_up" : "member_redirect",
				target: "Kelly",
				message: "shared msg",
				id: "cli-1",
			},
			socket,
		);

		// Same delivery intent on the wire...
		assert.equal(wire.length, 1);
		assert.equal(wire[0]!.delivery, intent === "follow_up" ? "follow_up" : "immediate", intent);
		assert.equal(wire[0]!.content, "shared msg", intent);
		// ...and the CLI-delegated server reports the same disposition the tool reports.
		const cliResponse = JSON.parse(writes[0]!);
		assert.equal(cliResponse.result.disposition, toolOutcome.details.disposition, intent);
		assert.equal(cliResponse.result.member.name, "Kelly", intent);
		assert.match(toolOutcome.content[0]!.text, /accepted/, intent);
	}
});
