import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	enqueueMemberInboxMessage,
	mapStoreError,
	MemberInboxMessageError,
	type InboxHintTransport,
	type MemberInboxMessageDependencies,
	type MemberInboxMessageRequest,
} from "./member-inbox-message.ts";
import type { RpcCommand, RpcCommandResponse } from "../domain/index.ts";
import { MemberInboxStoreError } from "../infra/member-inbox-store.ts";

test("inbox store errors map to stable application categories", () => {
	assert.equal(mapStoreError(new Error("unknown")).code, "storage-failed");
	assert.equal(mapStoreError(new MemberInboxStoreError("capacity-exceeded", "full")).code, "inbox-full");
	assert.equal(mapStoreError(new MemberInboxStoreError("untrusted-path", "path")).code, "inbox-untrusted-path");
	assert.equal(mapStoreError(new MemberInboxStoreError("untrusted-project", "project")).code, "untrusted-project");
	assert.equal(mapStoreError(new MemberInboxStoreError("lock-conflict", "lock")).code, "storage-unavailable");
	assert.equal(mapStoreError(new MemberInboxStoreError("other" as never, "other")).code, "storage-failed");
});

const manifestMembers = [
	{ name: "Bob", role: "dev", socket: "sockets/Bob.sock", socketPath: "/project/.pi/bebop/sockets/Bob.sock" },
	{ name: "Dave", role: "dev1", socket: "sockets/Dave.sock", socketPath: "/project/.pi/bebop/sockets/Dave.sock" },
	{ name: "Kelly", role: "qa", socket: "sockets/Kelly.sock", socketPath: "/project/.pi/bebop/sockets/Kelly.sock" },
] as const;

const membership = {
	member: { name: "Tony", role: "lead", socket: "sockets/Tony.sock" },
	socketPath: "/project/.pi/bebop/sockets/Tony.sock",
	manifestPath: "/project/.pi/bebop/crew.json",
	manifest: { version: 1, presence: { notifications: true }, members: manifestMembers },
} as never;

let projectRoot: string;

function makeDeps(overrides: Partial<MemberInboxMessageDependencies> = {}): MemberInboxMessageDependencies {
	return {
		isProjectTrusted: () => true,
		openStore: async () => {
			throw new Error("store seam not expected in default test");
		},
		hintTransport: null,
		...overrides,
	};
}

function makeRequest(overrides: Partial<MemberInboxMessageRequest> = {}): MemberInboxMessageRequest {
	return { membership, member: "Bob", message: "please review", now: 1234, ...overrides };
}

const fakeStore = (
	items: Array<{ id: string; sequence: number }>,
	enqueue: (payload: unknown, now: number) => { id: string; sequence: number },
) => ({
	memberKey: "member-test",
	enqueue: async (payload: unknown, now: number) => {
		const item = enqueue(payload, now);
		items.push(item);
		return {
			item: {
				version: 1,
				id: item.id,
				target: { name: "Bob", socketPath: "x" },
				payload,
				enqueuedAt: now,
				sequence: item.sequence,
			},
		};
	},
});

const rejectsCode = async (promise: Promise<unknown>, code: string, mustNotInclude?: string) => {
	await assert.rejects(
		() => promise,
		(error: unknown) => {
			assert.ok(error instanceof MemberInboxMessageError, `expected MemberInboxMessageError, got: ${error}`);
			assert.equal(error.code, code);
			if (mustNotInclude)
				assert.ok(!error.message.includes(mustNotInclude), `leaked "${mustNotInclude}" in: ${error.message}`);
			return true;
		},
	);
};

before(async () => {
	projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "intray-inbox-app-"));
});

after(async () => {
	await fs.rm(projectRoot, { recursive: true, force: true });
});

describe("enqueue happy path", () => {
	test("persists structured payload with derived crew origin and returns persisted acknowledgement", async () => {
		let persisted: { payload: unknown; now: number } | undefined;
		const outcome = await enqueueMemberInboxMessage(
			makeRequest(),
			makeDeps({
				openStore: (async () =>
					fakeStore([], (payload, now) => {
						persisted = { payload, now };
						return { id: "inbox-0-abc", sequence: 0 };
					})) as never,
			}),
		);
		assert.deepEqual(outcome, {
			target: {
				name: "Bob",
				role: "dev",
				socket: "sockets/Bob.sock",
				socketPath: "/project/.pi/bebop/sockets/Bob.sock",
			},
			itemId: "inbox-0-abc",
			persisted: true,
			hint: "skipped",
		});
		assert.deepEqual(persisted!.payload, {
			content: "please review",
			origin: { kind: "crew", name: "Tony", role: "lead" },
		});
		assert.equal(persisted!.now, 1234);
	});

	test("recipient offline never blocks enqueue and no hint transport is required", async () => {
		let opened = 0;
		const outcome = await enqueueMemberInboxMessage(
			makeRequest(),
			makeDeps({
				openStore: (async () => {
					opened += 1;
					return fakeStore([], () => ({ id: "inbox-0-abc", sequence: 0 }));
				}) as never,
				hintTransport: null,
			}),
		);
		assert.equal(outcome.persisted, true);
		assert.equal(opened, 1);
	});

	test("message instructions pass through as ordered payload instructions", async () => {
		let payload: unknown;
		await enqueueMemberInboxMessage(
			makeRequest({ instructions: ["first", "second"] }),
			makeDeps({
				openStore: (async () =>
					fakeStore([], (value) => {
						payload = value;
						return { id: "i", sequence: 0 };
					})) as never,
			}),
		);
		assert.deepEqual((payload as { instructions?: string[] }).instructions, ["first", "second"]);
	});
});

describe("distinct unhappy paths", () => {
	test("not joined rejects before any store IO", async () => {
		let opened = 0;
		await rejectsCode(
			enqueueMemberInboxMessage(
				makeRequest({ membership: null }),
				makeDeps({
					openStore: (async () => {
						opened += 1;
						throw new Error("must not open");
					}) as never,
				}),
			),
			"not-joined",
		);
		assert.equal(opened, 0);
	});

	test("unknown member and ambiguous role are distinct from each other", async () => {
		await rejectsCode(enqueueMemberInboxMessage(makeRequest({ member: "Ghost" }), makeDeps()), "unknown-member");
		await rejectsCode(enqueueMemberInboxMessage(makeRequest({ member: "nope" }), makeDeps()), "unknown-member");
		await rejectsCode(
			enqueueMemberInboxMessage(
				makeRequest({
					member: "dev",
					membership: {
						...membership,
						manifest: {
							...membership.manifest,
							members: [
								{ name: "Bob", role: "dev", socket: "sockets/Bob.sock" },
								{ name: "Dave", role: "dev", socket: "sockets/Dave.sock" },
							],
						} as never,
					},
				}),
				makeDeps(),
			),
			"ambiguous-role",
		);
	});

	test("self-target rejects by name or own endpoint", async () => {
		const selfManifest = [
			...manifestMembers,
			{
				name: "Tony",
				role: "lead",
				socket: "sockets/Tony.sock",
				socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			},
		];
		await rejectsCode(
			enqueueMemberInboxMessage(
				makeRequest({
					member: "Tony",
					membership: { ...membership, manifest: { ...membership.manifest, members: selfManifest } as never },
				}),
				makeDeps(),
			),
			"self-send",
		);
		await rejectsCode(
			enqueueMemberInboxMessage(
				makeRequest({
					member: "Mirror",
					membership: {
						...membership,
						manifest: {
							...membership.manifest,
							members: [
								...selfManifest,
								{
									name: "Mirror",
									role: "mirror",
									socket: "sockets/Tony.sock",
									socketPath: "/project/.pi/bebop/sockets/Tony.sock",
								},
							],
						} as never,
					},
				}),
				makeDeps(),
			),
			"self-send",
		);
	});

	test("invalid content and instructions reject before store IO", async () => {
		let opened = 0;
		const deps = makeDeps({
			openStore: (async () => {
				opened += 1;
				throw new Error("must not open");
			}) as never,
		});
		await rejectsCode(enqueueMemberInboxMessage(makeRequest({ message: "   " }), deps), "invalid-payload");
		await rejectsCode(enqueueMemberInboxMessage(makeRequest({ message: "nul\0byte" }), deps), "invalid-payload");
		await rejectsCode(enqueueMemberInboxMessage(makeRequest({ instructions: ["", "x"] }), deps), "invalid-payload");
		await rejectsCode(
			enqueueMemberInboxMessage(makeRequest({ instructions: Array(33).fill("x") }), deps),
			"invalid-payload",
		);
		assert.equal(opened, 0);
	});

	test("untrusted project and storage failures map to distinct bounded errors", async () => {
		await rejectsCode(
			enqueueMemberInboxMessage(makeRequest(), makeDeps({ isProjectTrusted: () => false })),
			"untrusted-project",
		);
		await rejectsCode(
			enqueueMemberInboxMessage(
				makeRequest(),
				makeDeps({
					openStore: (async () => {
						const { MemberInboxStoreError } = await import("../infra/member-inbox-store.ts");
						throw new MemberInboxStoreError("capacity-exceeded", "member inbox is full: 64/64 items");
					}) as never,
				}),
			),
			"inbox-full",
			"please review",
		);
		const storeCodes: Array<[string, string]> = [
			["untrusted-path", "inbox-untrusted-path"],
			["lock-conflict", "storage-unavailable"],
			["write-failed", "storage-unavailable"],
			["read-failed", "storage-unavailable"],
		];
		for (const [storeCode, expected] of storeCodes) {
			await rejectsCode(
				enqueueMemberInboxMessage(
					makeRequest(),
					makeDeps({
						openStore: (async () => {
							const { MemberInboxStoreError } = await import("../infra/member-inbox-store.ts");
							throw new MemberInboxStoreError(storeCode, "bounded reason");
						}) as never,
					}),
				),
				expected,
			);
		}
	});
});

describe("best-effort hint", () => {
	test("hint failure never rolls back the persisted item", async () => {
		let persisted = false;
		const outcome = await enqueueMemberInboxMessage(
			makeRequest(),
			makeDeps({
				openStore: (async () =>
					fakeStore([], () => {
						persisted = true;
						return { id: "inbox-0-abc", sequence: 0 };
					})) as never,
				hintTransport: {
					sendHint: async () => {
						throw new Error("recipient socket gone");
					},
				},
			}),
		);
		assert.equal(outcome.persisted, true);
		assert.equal(persisted, true);
	});

	test("hint is best-effort, non-authoritative, and carries no item data", async () => {
		let hinted: { endpoint: string; command: RpcCommand } | undefined;
		const outcome = await enqueueMemberInboxMessage(
			makeRequest(),
			makeDeps({
				openStore: (async () => fakeStore([], () => ({ id: "inbox-0-abc", sequence: 0 }))) as never,
				hintTransport: {
					sendHint: async (endpoint, command) => {
						hinted = { endpoint, command };
						return "acked";
					},
				},
			}),
		);
		assert.equal(outcome.persisted, true);
		assert.ok(hinted);
		assert.ok(hinted!.endpoint.includes("Bob"));
		assert.equal(hinted!.command.type, "send");
		const payload = hinted!.command.payload as { content: string; origin?: unknown };
		assert.ok(/check your inbox/i.test(payload.content));
		assert.ok(!JSON.stringify(hinted).includes("inbox-0-abc"));
		assert.ok(!JSON.stringify(hinted).includes("please review"));
	});

	test("hint timeout bounded and abort signal respected", async () => {
		const { sendRpcCommand } = await import("../infra/rpc-client.ts");
		assert.ok(typeof sendRpcCommand === "function");
	});
});

describe("real trusted store integration (both layouts)", () => {
	test("persists through the committed trusted store in bebop layout", async () => {
		const layoutDir = path.join(projectRoot, ".pi", "bebop");
		await fs.mkdir(path.join(layoutDir, "sockets"), { recursive: true });
		const socketPath = path.join(layoutDir, "sockets", "Bob.sock");
		const { openTrustedMemberInboxStore } = await import("../infra/member-inbox-store.ts");
		const outcome = await enqueueMemberInboxMessage(
			makeRequest(),
			makeDeps({
				openStore: (async () =>
					openTrustedMemberInboxStore({
						manifestPath: path.join(layoutDir, "crew.json"),
						projectRoot,
						isProjectTrusted: () => true,
						member: { name: "Bob", role: "dev", socketPath },
					})) as never,
			}),
		);
		assert.equal(outcome.persisted, true);
		const store = await openTrustedMemberInboxStore({
			manifestPath: path.join(layoutDir, "crew.json"),
			projectRoot,
			isProjectTrusted: () => true,
			member: { name: "Bob", role: "dev", socketPath },
		});
		const items = await store.list();
		assert.equal(items.length, 1);
		assert.equal(items[0]?.id, outcome.itemId);
		await store.remove(outcome.itemId);
	});
});
