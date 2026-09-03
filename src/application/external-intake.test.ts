import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CrewManifestError } from "../domain/index.ts";
import type { CrewManifest } from "../domain/index.ts";
import { CrewManifestReadError } from "../infra/crew-manifest-store.ts";
import { MemberInboxStoreError } from "../infra/member-inbox-store.ts";
import { ExternalIntakeError, submitExternalIntake, type ExternalIntakeDependencies } from "./external-intake.ts";
import type { InboxItem, MessagePayload } from "../domain/index.ts";

const manifest: CrewManifest = {
	version: 1,
	members: [
		{ name: "Mary", role: "po", socket: "sockets/po.sock", socketPath: "/project/.pi/bebop/sockets/po.sock" },
		{ name: "Bob", role: "dev", socket: "sockets/dev.sock", socketPath: "/project/.pi/bebop/sockets/dev.sock" },
	],
	presence: { notifications: true },
	intake: { contact: "Mary" },
};

const item = (id: string): InboxItem => ({
	version: 1,
	id,
	target: { name: "Mary", socketPath: "/project/.pi/bebop/sockets/po.sock" },
	payload: { content: "x" },
	enqueuedAt: 1234,
	sequence: 0,
});

const rejectsCode = async (promise: Promise<unknown>, code: string, mustNotInclude?: string) => {
	await assert.rejects(
		() => promise,
		(error: unknown) => {
			assert.ok(error instanceof ExternalIntakeError, `expected ExternalIntakeError, got: ${error}`);
			assert.equal(error.code, code);
			if (mustNotInclude) assert.ok(!error.message.includes(mustNotInclude), `leaked: ${error.message}`);
			return true;
		},
	);
};

interface Harness {
	opened: Array<{ member: { name: string; socketPath: string } }>;
	enqueued: Array<{ payload: unknown; now: number }>;
	setManifest(value: CrewManifest): void;
	setStoreError(error: unknown): void;
	setEnqueueError(error: unknown): void;
}

function makeDeps(overrides: Partial<ExternalIntakeDependencies> = {}): Harness & { deps: ExternalIntakeDependencies } {
	const opened: Array<{ member: { name: string; socketPath: string } }> = [];
	const enqueued: Array<{ payload: unknown; now: number }> = [];
	let currentManifest = manifest;
	let storeError: unknown;
	let enqueueError: unknown;
	const harness: Harness = {
		opened,
		enqueued,
		setManifest(value) {
			currentManifest = value;
		},
		setStoreError(error) {
			storeError = error;
		},
		setEnqueueError(error) {
			enqueueError = error;
		},
	};
	const deps: ExternalIntakeDependencies = {
		loadManifest: async () => currentManifest,
		openStore: async (options) => {
			opened.push({ member: { name: options.member.name, socketPath: options.member.socketPath } });
			if (storeError !== undefined) throw storeError;
			return {
				memberKey: "member-test",
				enqueue: async (payload, now) => {
					if (enqueueError !== undefined) throw enqueueError;
					enqueued.push({ payload, now });
					return { item: item("inbox-0-abc") };
				},
				peekOldest: async () => null,
				list: async () => [],
				count: async () => 0,
				remove: async () => ({ removed: false }),
				cancel: async () => ({ removed: false }),
			};
		},
		now: () => 1234,
		...overrides,
	};
	return { ...harness, deps };
}

describe("submitExternalIntake happy path", () => {
	test("persists one-way message to the configured contact inbox and returns the ack", async () => {
		const harness = makeDeps();
		const ack = await submitExternalIntake(
			{
				manifestPath: "/project/.pi/bebop/crew.json",
				label: "jira-automation",
				content: "Evaluate this request",
				instructions: ["Triage"],
			},
			harness.deps,
		);
		assert.deepEqual(ack, {
			ok: true,
			itemId: "inbox-0-abc",
			persisted: true,
			contact: "Mary",
			contactRole: "po",
		});
		assert.equal(harness.opened.length, 1);
		assert.equal(harness.opened[0]!.member.name, "Mary");
		assert.equal(harness.opened[0]!.member.socketPath, "/project/.pi/bebop/sockets/po.sock");
		assert.equal(harness.enqueued.length, 1);
		assert.deepEqual(harness.enqueued[0]!.payload, {
			content: "Evaluate this request",
			instructions: ["Triage"],
			origin: { kind: "external", label: "jira-automation" },
			kind: "external intake",
		});
		assert.equal(harness.enqueued[0]!.now, 1234);
	});

	test("ack and payload never carry a reply route or promised response", async () => {
		const harness = makeDeps();
		const ack = await submitExternalIntake(
			{ manifestPath: "/project/.pi/bebop/crew.json", label: "script", content: "hello" },
			harness.deps,
		);
		assert.ok(!JSON.stringify(ack).includes("replyTo"));
		assert.ok(!JSON.stringify(ack).includes("sessionId"));
		assert.ok(!JSON.stringify(harness.enqueued[0]!.payload).includes("replyTo"));
	});

	test("contact may be offline: no endpoint probe or session is required", async () => {
		const harness = makeDeps();
		const ack = await submitExternalIntake(
			{ manifestPath: "/project/.pi/bebop/crew.json", label: "x", content: "offline ok" },
			harness.deps,
		);
		assert.equal(ack.persisted, true);
	});
});

describe("distinct intake errors", () => {
	test("manifest parse failure maps to invalid-manifest", async () => {
		const harness = makeDeps();
		harness.setManifest(manifest);
		const failing = makeDeps({
			loadManifest: async () => {
				throw new CrewManifestError(
					"invalid-intake-contact",
					"intake contact is not a configured member: Ghost",
				);
			},
		});
		await rejectsCode(
			submitExternalIntake({ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "x" }, failing.deps),
			"invalid-manifest",
		);
	});

	test("unsafe layout, read failure, and invalid JSON map to distinct stable codes", async () => {
		const cases: Array<[CrewManifestReadError, string]> = [
			[new CrewManifestReadError("untrusted-path", "not an exact supported layout"), "untrusted-path"],
			[new CrewManifestReadError("read-failed", "cannot read"), "read-failed"],
			[new CrewManifestReadError("invalid-json", "bad json"), "invalid-json"],
		];
		for (const [error, expected] of cases) {
			const failing = makeDeps({
				loadManifest: async () => {
					throw error;
				},
			});
			await rejectsCode(
				submitExternalIntake(
					{ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "x" },
					failing.deps,
				),
				expected,
			);
		}
	});

	test("no contact yields external-intake-disabled with no fallback", async () => {
		const harness = makeDeps();
		harness.setManifest({ ...manifest, intake: undefined });
		await rejectsCode(
			submitExternalIntake({ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "x" }, harness.deps),
			"external-intake-disabled",
		);
	});

	test("malformed message or instructions map to invalid-payload before store IO", async () => {
		let opened = 0;
		const deps = makeDeps({
			openStore: async () => {
				opened += 1;
				throw new Error("must not open");
			},
		}).deps;
		for (const content of ["   ", "nul\0byte"]) {
			await rejectsCode(
				submitExternalIntake({ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content }, deps),
				"invalid-payload",
			);
		}
		await rejectsCode(
			submitExternalIntake(
				{ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "ok", instructions: [""] },
				deps,
			),
			"invalid-payload",
		);
		assert.equal(opened, 0);
	});

	test("full inbox, untrusted store, and storage failure map to distinct codes", async () => {
		const full = makeDeps();
		full.setEnqueueError(new MemberInboxStoreError("capacity-exceeded", "full"));
		await rejectsCode(
			submitExternalIntake({ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "x" }, full.deps),
			"inbox-full",
		);

		const untrusted = makeDeps();
		untrusted.setStoreError(new MemberInboxStoreError("untrusted-project", "not trusted"));
		await rejectsCode(
			submitExternalIntake({ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "x" }, untrusted.deps),
			"inbox-untrusted",
		);

		const unavailable = makeDeps();
		unavailable.setEnqueueError(new MemberInboxStoreError("write-failed", "disk"));
		await rejectsCode(
			submitExternalIntake(
				{ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "x" },
				unavailable.deps,
			),
			"storage-unavailable",
		);
	});
});

describe("error mapping fallbacks", () => {
	test("unknown loader, store-open, and enqueue failures map to stable generic codes", async () => {
		const unknownLoad = makeDeps({
			loadManifest: async () => {
				throw new Error("boom");
			},
		});
		await rejectsCode(
			submitExternalIntake(
				{ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "x" },
				unknownLoad.deps,
			),
			"invalid-manifest",
		);

		const unknownOpen = makeDeps();
		unknownOpen.setStoreError(new Error("boom"));
		await rejectsCode(
			submitExternalIntake(
				{ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "x" },
				unknownOpen.deps,
			),
			"intake-storage-failed",
		);

		const unknownEnqueue = makeDeps();
		unknownEnqueue.setEnqueueError(new Error("boom"));
		await rejectsCode(
			submitExternalIntake(
				{ manifestPath: "/p/.pi/bebop/crew.json", label: "x", content: "x" },
				unknownEnqueue.deps,
			),
			"intake-storage-failed",
		);
	});
});
