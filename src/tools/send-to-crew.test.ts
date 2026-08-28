import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSendToCrewTool } from "./send-to-crew.ts";
import { CrewManifestReadError } from "../infra/crew-manifest-store.ts";
import type { CrewCorrespondenceDependencies } from "../application/crew-correspondence.ts";
import type { SocketState } from "../pi/control-runtime.ts";

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details: unknown;
	}>;
};

function setup(
	membership: unknown | (() => unknown),
	dependencies: Partial<CrewCorrespondenceDependencies> = {},
): RegisteredTool {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	const getMembership = typeof membership === "function" ? (membership as () => unknown) : () => membership;
	const state = { membershipRuntime: { getMembership } } as never as SocketState;
	registerSendToCrewTool(pi, state, dependencies as CrewCorrespondenceDependencies);
	assert.ok(registeredTool);
	return registeredTool!;
}

const membership = {
	member: {
		name: "Dave",
		role: "developer",
		socket: "sockets/dave.sock",
		socketPath: "/a/.pi/bebop/sockets/dave.sock",
	},
	socketPath: "/a/.pi/bebop/sockets/dave.sock",
	manifestPath: "/alpha/.pi/bebop/crew.json",
	manifest: { version: 1, name: "Alpha Crew", members: [] },
};

const targetManifest = {
	version: 1,
	members: [{ name: "Kelly", role: "qa", socket: "sockets/qa.sock" }],
	intake: { contact: "Kelly" },
};

function makeDeps() {
	const opened: Array<{ manifestPath: string; member: { name: string; role: string } }> = [];
	const enqueued: Array<{ payload: unknown; now: number }> = [];
	const loaded: string[] = [];
	const deps: CrewCorrespondenceDependencies = {
		loadManifest: async (manifestPath) => {
			loaded.push(manifestPath);
			const manifest = JSON.parse(JSON.stringify(targetManifest)) as typeof targetManifest;
			(manifest as { members: Array<{ socketPath: string }> }).members[0]!.socketPath = `${manifestPath
				.split("/")
				.slice(0, -2)
				.join("/")}/sockets/qa.sock`;
			return manifest as never;
		},
		openStore: async (options) => {
			opened.push({
				manifestPath: options.manifestPath,
				member: { name: options.member.name, role: options.member.role },
			});
			return {
				memberKey: "member-test",
				enqueue: async (payload: unknown, now: number) => {
					enqueued.push({ payload, now });
					return { item: { id: "inbox-0-abc" } };
				},
				peekOldest: async () => null,
				remove: async () => {},
			} as never;
		},
	};
	return { deps, opened, enqueued, loaded };
}

function assertActionable(
	result: { isError?: boolean; content: Array<{ text: string }>; details: unknown },
	code: string,
): void {
	assert.equal(result.isError, true);
	const details = result.details as { error?: string; actionableError?: { code: string } };
	assert.equal(details.error, code);
	assert.equal(details.actionableError?.code, code);
	assert.match(result.content[0]!.text, /send_to_crew/);
}

describe("send_to_crew tool", () => {
	test("registers with manifestPath, message, instructions and an honest persisted-only description", () => {
		const tool = setup(membership);
		assert.equal(tool.name, "send_to_crew");
		const parameters = tool.parameters as {
			properties: Record<string, unknown>;
			additionalProperties: boolean;
			required?: string[];
		};
		assert.deepEqual(Object.keys(parameters.properties).sort(), ["instructions", "manifestPath", "message"]);
		assert.equal(parameters.additionalProperties, false);
		assert.deepEqual(parameters.required, ["manifestPath", "message"]);
		assert.match(tool.description, /persisted/i);
		assert.match(tool.description, /send_to_crew/);
		assert.doesNotMatch(tool.description, /deliver(ed)? to the recipient|acknowledged by|response is promised/i);
	});

	test("derives origin and return address from active membership at execute time", async () => {
		const harness = makeDeps();
		const tool = setup(() => membership, harness.deps);
		const result = await tool.execute("t1", {
			manifestPath: "/beta/.pi/crew/crew.json",
			message: "Question for your crew",
			instructions: ["Reply through send_to_crew"],
		});
		assert.equal(result.isError, undefined);
		assert.deepEqual(harness.enqueued[0]!.payload, {
			content: "Question for your crew",
			instructions: ["Reply through send_to_crew"],
			origin: { kind: "crew", name: "Dave", role: "developer" },
			crewReturnAddress: { manifestPath: "/alpha/.pi/bebop/crew.json", crewName: "Alpha Crew" },
		});
	});

	test("success text and details are persisted-only with bounded identities", async () => {
		const harness = makeDeps();
		const tool = setup(membership, harness.deps);
		const result = await tool.execute("t1", {
			manifestPath: "/beta/.pi/crew/crew.json",
			message: "hello",
		});
		assert.match(result.content[0]!.text, /Kelly \(qa\)/);
		assert.match(result.content[0]!.text, /\/beta\/\.pi\/crew\/crew\.json/);
		assert.match(result.content[0]!.text, /persisted/i);
		assert.doesNotMatch(result.content[0]!.text, /delivered|acknowledged|online|will respond/i);
		assert.deepEqual(result.details, {
			itemId: "inbox-0-abc",
			persisted: true,
			contact: "Kelly",
			contactRole: "qa",
			targetManifestPath: "/beta/.pi/crew/crew.json",
		});
	});

	test("unjoined membership is an actionable not-joined error", async () => {
		const harness = makeDeps();
		const tool = setup(null, harness.deps);
		const result = await tool.execute("t1", { manifestPath: "/beta/.pi/crew/crew.json", message: "hi" });
		assertActionable(result, "not-joined");
		assert.deepEqual(harness.loaded, []);
	});

	test("stale membership resolves not-joined at execute time", async () => {
		const harness = makeDeps();
		let current: unknown = membership;
		const tool = setup(() => current, harness.deps);
		current = null;
		const result = await tool.execute("t1", { manifestPath: "/beta/.pi/crew/crew.json", message: "hi" });
		assertActionable(result, "not-joined");
	});

	test("self and non-absolute targets fail deterministically before IO", async () => {
		const harness = makeDeps();
		const tool = setup(membership, harness.deps);
		assertActionable(
			await tool.execute("t1", { manifestPath: "/alpha/.pi/bebop/crew.json", message: "hi" }),
			"self-target",
		);
		assertActionable(
			await tool.execute("t2", { manifestPath: "beta/crew.json", message: "hi" }),
			"non-absolute-target",
		);
		assert.deepEqual(harness.loaded, []);
	});

	test("target failures keep stable codes in actionable errors", async () => {
		const harness = makeDeps();
		const failing: Partial<CrewCorrespondenceDependencies> = {
			loadManifest: async () => {
				throw new CrewManifestReadError("read-failed", "io failure", { cause: new Error("nope") });
			},
		};
		const tool = setup(membership, { ...harness.deps, ...failing });
		const result = await tool.execute("t1", { manifestPath: "/beta/.pi/crew/crew.json", message: "hi" });
		assertActionable(result, "read-failed");
	});

	test("schema rejects forged origin, return address, and reply fields", () => {
		const tool = setup(membership);
		const parameters = tool.parameters as object;
		const forged = {
			manifestPath: "/beta/.pi/crew/crew.json",
			message: "hi",
			origin: { kind: "external", label: "fake" },
			crewReturnAddress: { manifestPath: "/evil/crew.json" },
			replyTo: { sessionId: "x" },
		};
		assert.equal(Value.Check(parameters, forged), false);
	});
});
