import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcProtocolError } from "../../infra/rpc-client.ts";
import { UsageError } from "../support/arguments.ts";
import {
	guestWireErrorCode,
	runGuestJoinCommand,
	runGuestLeaveCommand,
	runGuestMessageCommand,
	type GuestCliDependencies,
} from "./guest.ts";
import type { CliContext } from "../support/context.ts";
import { runCli } from "../run.ts";
import { createGuestRegistryStore, digestGuestCapability } from "../../infra/guest-registry-store.ts";

const context = {} as CliContext;

function depsWith(response: unknown, error?: unknown): { deps: GuestCliDependencies; calls: unknown[] } {
	const calls: unknown[] = [];
	return {
		calls,
		deps: {
			sendCommand: async (target: unknown, command: unknown) => {
				calls.push({ target, command });
				if (error !== undefined) throw error;
				return { response } as never;
			},
		},
	};
}

test("Guest message execution loads a trusted Crew manifest before authorization", async () => {
	const root = await mkdtemp(path.join("/tmp", "bebop-guest-cli-"));
	try {
		assert.equal(await runCli(["crew", "init", "--project", root], root, process.stdin, new PassThrough()), 0);
		const manifestPath = path.join(root, ".pi", "bebop", "crew.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.crew = { id: "alpha", displayName: "Alpha" };
		await writeFile(manifestPath, JSON.stringify(manifest));
		for (const command of ["guest-send", "guest-broadcast"] as const) {
			const outcome = await runGuestMessageCommand(
				{
					command,
					crew: "alpha",
					target: command === "guest-send" ? "Mary" : undefined,
					guestIdentity: "guest-1",
					guestName: "Alex",
					callback: "/tmp/callback.sock",
					capability: "cap-1",
					message: "hello",
					instructions: [],
					format: "toon",
				},
				{ cwd: root, input: process.stdin, signal: new AbortController().signal },
				{ sendCommand: async () => ({ response: { success: true, data: {} } }) as never },
			);
			assert.equal(outcome.kind, "result");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Guest message execution sends after a trusted approved registry binding", async () => {
	const root = await mkdtemp(path.join("/tmp", "bebop-guest-approved-"));
	try {
		assert.equal(await runCli(["crew", "init", "--project", root], root, process.stdin, new PassThrough()), 0);
		const manifestPath = path.join(root, ".pi", "bebop", "crew.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.crew = { id: "alpha", displayName: "Alpha" };
		await writeFile(manifestPath, JSON.stringify(manifest));
		await cp(path.join(root, ".pi", "bebop"), path.join(root, ".pi", "crew"), { recursive: true });
		const foreignPath = path.join(root, ".pi", "crew", "crew.json");
		const foreignManifest = JSON.parse(await readFile(foreignPath, "utf8")) as Record<string, unknown>;
		foreignManifest.crew = { id: "beta", displayName: "Beta" };
		await writeFile(foreignPath, JSON.stringify(foreignManifest));
		createGuestRegistryStore({ manifestPath, crew: { id: "alpha", displayName: "Alpha" } }).replaceEntries([
			{
				status: "approved",
				record: {
					crew: { id: "alpha", displayName: "Alpha" },
					guestIdentity: "guest-1",
					guestName: "Alex",
					callbackEndpoint: "/tmp/callback.sock",
					approvedBy: "lead",
				},
				capabilityDigest: digestGuestCapability("cap-1"),
			},
			{
				status: "approved",
				record: {
					crew: { id: "alpha", displayName: "Alpha" },
					guestIdentity: "guest-2",
					guestName: "Blair",
					callbackEndpoint: "/tmp/blair.sock",
					approvedBy: "lead",
				},
				capabilityDigest: digestGuestCapability("cap-2"),
			},
			{
				status: "denied",
				request: {
					crew: { id: "alpha", displayName: "Alpha" },
					guestIdentity: "guest-denied",
					guestName: "Denied",
					callbackEndpoint: "/tmp/denied.sock",
				},
				approver: "lead",
			},
		]);
		const outcome = await runGuestMessageCommand(
			{
				command: "guest-send",
				crew: "alpha",
				target: "lead",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: ["one"],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () =>
					({
						response: {
							success: true,
							data: { deliveryId: "d-1", disposition: "direct", fromGuestName: "Alex" },
						},
					}) as never,
			},
		);
		assert.equal(outcome.kind, "result");
		const broadcast = await runGuestMessageCommand(
			{
				command: "guest-broadcast",
				crew: "alpha",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () =>
					({
						response: {
							success: true,
							data: { deliveryId: "d-2", disposition: "direct", fromGuestName: "Alex" },
						},
					}) as never,
			},
		);
		assert.equal(broadcast.kind, "result");
		const partial = await runGuestMessageCommand(
			{
				command: "guest-broadcast",
				crew: "alpha",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () => {
					throw new Error("offline");
				},
			},
		);
		assert.equal(partial.kind, "result");
		const rejected = await runGuestMessageCommand(
			{
				command: "guest-send",
				crew: "alpha",
				target: "lead",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () => {
					throw new RpcProtocolError("remote-error", "remote-error: not-found");
				},
			},
		);
		assert.equal(rejected.kind, "result");
		const blankFailure = await runGuestMessageCommand(
			{
				command: "guest-send",
				crew: "alpha",
				target: "lead",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () => {
					throw new Error("");
				},
			},
		);
		assert.equal(blankFailure.kind, "result");
		const invalidAck = await runGuestMessageCommand(
			{
				command: "guest-send",
				crew: "alpha",
				target: "lead",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{ sendCommand: async () => ({ response: { success: true, data: {} } }) as never },
		);
		assert.equal(invalidAck.kind, "result");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Guest routing rejects ambiguous trusted manifest layouts", async () => {
	const root = await mkdtemp(path.join("/tmp", "bebop-guest-ambiguous-"));
	try {
		assert.equal(await runCli(["crew", "init", "--project", root], root, process.stdin, new PassThrough()), 0);
		await cp(path.join(root, ".pi", "bebop"), path.join(root, ".pi", "crew"), { recursive: true });
		for (const layout of ["bebop", "crew"]) {
			const manifestPath = path.join(root, ".pi", layout, "crew.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
			manifest.crew = { id: "alpha", displayName: "Alpha" };
			await writeFile(manifestPath, JSON.stringify(manifest));
		}
		const output = new PassThrough();
		const err = new PassThrough();
		let text = "";
		let errText = "";
		output.setEncoding("utf8");
		err.setEncoding("utf8");
		output.on("data", (chunk) => (text += chunk));
		err.on("data", (chunk) => (errText += chunk));
		const code = await runCli(
			[
				"guest",
				"send",
				"--crew",
				"alpha",
				"--target",
				"lead",
				"--identity",
				"guest-1",
				"--as",
				"Alex",
				"--callback",
				"c",
				"--capability",
				"cap",
				"--message",
				"hello",
			],
			root,
			process.stdin,
			output,
			err,
		);
		assert.equal(code, 1);
		assert.equal(text, "");
		assert.match(errText, /multiple trusted manifests/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("production Guest send and broadcast use declared routing without a positional socket", async () => {
	for (const kind of ["send", "broadcast"] as const) {
		const output = new PassThrough();
		const err = new PassThrough();
		let text = "";
		let errText = "";
		output.setEncoding("utf8");
		err.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		err.on("data", (chunk) => {
			errText += chunk;
		});
		const args = [
			"guest",
			kind,
			"--crew",
			"alpha",
			...(kind === "send" ? ["--target", "Mary"] : []),
			"--identity",
			"guest-1",
			"--as",
			"Alex",
			"--callback",
			"/tmp/callback.sock",
			"--capability",
			"cap-1",
			"--message",
			"hello",
		];
		const code = await runCli(args, "/tmp/task-0168-no-manifest", process.stdin, output, err);
		assert.equal(code, 1, kind);
		assert.equal(text, "");
		assert.match(errText, /No trusted crew manifest found/);
	}
});
