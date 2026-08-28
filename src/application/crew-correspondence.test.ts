import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CrewManifestError, parseCrewManifest, type CrewManifest } from "../domain/index.ts";
import type { InboxItem, MessagePayload } from "../domain/index.ts";
import { CrewManifestReadError, readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import { MemberInboxStoreError, openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import {
	CrewCorrespondenceError,
	sendCrewCorrespondence,
	type CrewCorrespondenceDependencies,
} from "./crew-correspondence.ts";

const manifest: CrewManifest = parseCrewManifest(
	{
		version: 1,
		members: [
			{ name: "Kelly", role: "qa", socket: "sockets/qa.sock" },
			{ name: "Mary", role: "po", socket: "sockets/po.sock" },
		],
		intake: { contact: "Kelly" },
	},
	"/beta/.pi/crew/crew.json",
);

const membership = {
	member: { name: "Dave", role: "developer" },
	manifestPath: "/alpha/.pi/bebop/crew.json",
	manifest: { name: "Alpha Crew", members: [] },
};

const item = (id: string): InboxItem => ({
	version: 1,
	id,
	target: { name: "Kelly", socketPath: "/beta/.pi/crew/sockets/qa.sock" },
	payload: { content: "x" },
	enqueuedAt: 1234,
	sequence: 0,
});

const rejectsCode = async (promise: Promise<unknown>, code: string, mustNotInclude?: string) => {
	await assert.rejects(
		() => promise,
		(error: unknown) => {
			assert.ok(error instanceof CrewCorrespondenceError, `expected CrewCorrespondenceError, got: ${error}`);
			assert.equal(error.code, code);
			if (mustNotInclude) assert.ok(!error.message.includes(mustNotInclude), `leaked: ${error.message}`);
			return true;
		},
	);
};

interface Harness {
	opened: Array<{ manifestPath: string; member: { name: string; role: string } }>;
	enqueued: Array<{ payload: unknown; now: number }>;
	loaded: string[];
	setManifest(value: CrewManifest): void;
	setLoadError(error: unknown): void;
	setStoreError(error: unknown): void;
	setEnqueueError(error: unknown): void;
}

function makeDeps(overrides: Partial<CrewCorrespondenceDependencies> = {}): Harness & {
	deps: CrewCorrespondenceDependencies;
} {
	const opened: Harness["opened"] = [];
	const enqueued: Harness["enqueued"] = [];
	const loaded: string[] = [];
	let currentManifest = manifest;
	let loadError: unknown;
	let storeError: unknown;
	let enqueueError: unknown;
	const harness: Harness = {
		opened,
		enqueued,
		loaded,
		setManifest(value) {
			currentManifest = value;
		},
		setLoadError(error) {
			loadError = error;
		},
		setStoreError(error) {
			storeError = error;
		},
		setEnqueueError(error) {
			enqueueError = error;
		},
	};
	const deps: CrewCorrespondenceDependencies = {
		loadManifest: async (manifestPath) => {
			loaded.push(manifestPath);
			if (loadError !== undefined) throw loadError;
			return currentManifest;
		},
		openStore: async (options) => {
			opened.push({
				manifestPath: options.manifestPath,
				member: { name: options.member.name, role: options.member.role },
			});
			if (storeError !== undefined) throw storeError;
			return {
				memberKey: "member-test",
				enqueue: async (payload, now) => {
					if (enqueueError !== undefined) throw enqueueError;
					enqueued.push({ payload, now });
					return { item: item("inbox-0-abc") };
				},
				peekOldest: async () => null,
				remove: async () => {},
			} as never;
		},
		...overrides,
	};
	return { ...harness, deps };
}

const request = (overrides: Partial<Parameters<typeof sendCrewCorrespondence>[0]> = {}) => ({
	membership,
	targetManifestPath: "/beta/.pi/crew/crew.json",
	message: "Question for your crew",
	now: 1234,
	...overrides,
});

describe("sendCrewCorrespondence happy path", () => {
	test("persists crew-correspondence payload with derived origin and return address", async () => {
		const harness = makeDeps();
		const outcome = await sendCrewCorrespondence(
			request({ instructions: ["Reply through send_to_crew"] }),
			harness.deps,
		);
		assert.deepEqual(outcome, {
			ok: true,
			itemId: "inbox-0-abc",
			persisted: true,
			contact: "Kelly",
			contactRole: "qa",
			targetManifestPath: "/beta/.pi/crew/crew.json",
		});
		assert.deepEqual(harness.enqueued[0]!.payload, {
			content: "Question for your crew",
			instructions: ["Reply through send_to_crew"],
			origin: { kind: "crew", name: "Dave", role: "developer" },
			crewReturnAddress: { manifestPath: "/alpha/.pi/bebop/crew.json", crewName: "Alpha Crew" },
		});
		assert.equal(harness.enqueued[0]!.now, 1234);
		assert.equal(harness.opened[0]!.member.name, "Kelly");
	});

	test("omits the crew label when the source manifest has no display name", async () => {
		const harness = makeDeps();
		await sendCrewCorrespondence(
			request({ membership: { ...membership, manifest: { members: [] } } }),
			harness.deps,
		);
		assert.deepEqual((harness.enqueued[0]!.payload as MessagePayload).crewReturnAddress, {
			manifestPath: "/alpha/.pi/bebop/crew.json",
		});
	});

	test("canonicalizes the target path before manifest load and store open", async () => {
		const harness = makeDeps();
		const outcome = await sendCrewCorrespondence(
			request({ targetManifestPath: "//beta/x/../.pi/crew/crew.json/" }),
			harness.deps,
		);
		assert.equal(outcome.targetManifestPath, "/beta/.pi/crew/crew.json");
		assert.deepEqual(harness.loaded, ["/beta/.pi/crew/crew.json"]);
		assert.equal(harness.opened[0]!.manifestPath, "/beta/.pi/crew/crew.json");
	});
});

describe("sendCrewCorrespondence rejections before IO", () => {
	test("unjoined membership is rejected before any target IO", async () => {
		const harness = makeDeps();
		await rejectsCode(sendCrewCorrespondence(request({ membership: null }), harness.deps), "not-joined");
		assert.deepEqual(harness.loaded, []);
	});

	test("non-absolute targets are rejected before any target IO", async () => {
		const harness = makeDeps();
		for (const bad of ["beta/.pi/crew/crew.json", "", "\0/beta/crew.json", "../beta/crew.json"]) {
			await rejectsCode(
				sendCrewCorrespondence(request({ targetManifestPath: bad }), harness.deps),
				"non-absolute-target",
			);
		}
		assert.deepEqual(harness.loaded, []);
	});

	test("self targets are rejected before any target IO, including non-canonical spellings", async () => {
		const harness = makeDeps();
		for (const self of [
			"/alpha/.pi/bebop/crew.json",
			"/alpha//.pi/bebop/./crew.json",
			"/alpha/x/../.pi/bebop/crew.json",
		]) {
			await rejectsCode(
				sendCrewCorrespondence(request({ targetManifestPath: self }), harness.deps),
				"self-target",
			);
		}
		assert.deepEqual(harness.loaded, []);
	});

	test("invalid payloads are rejected deterministically", async () => {
		const harness = makeDeps();
		await rejectsCode(sendCrewCorrespondence(request({ message: "   " }), harness.deps), "invalid-payload");
		assert.deepEqual(harness.loaded, []);
	});
});

describe("sendCrewCorrespondence maps target and storage failures", () => {
	test("manifest load failures keep stable intake codes", async () => {
		for (const [error, code] of [
			[new CrewManifestReadError("untrusted-path", "layout"), "untrusted-path"],
			[new CrewManifestReadError("read-failed", "io"), "read-failed"],
			[new CrewManifestReadError("invalid-json", "json"), "invalid-json"],
			[new CrewManifestError("invalid-manifest", "schema"), "invalid-manifest"],
			[new Error("boom"), "invalid-manifest"],
		] as const) {
			const harness = makeDeps();
			harness.setLoadError(error);
			await rejectsCode(sendCrewCorrespondence(request(), harness.deps), code);
		}
	});

	test("disabled intake and unknown contact are distinct deterministic codes", async () => {
		const disabled = makeDeps();
		disabled.setManifest(
			parseCrewManifest(
				{ version: 1, members: [{ name: "Kelly", role: "qa", socket: "sockets/qa.sock" }] },
				"/beta/.pi/crew/crew.json",
			),
		);
		await rejectsCode(sendCrewCorrespondence(request(), disabled.deps), "external-intake-disabled");

		const unknown = makeDeps();
		const mutated = parseCrewManifest(
			{
				version: 1,
				members: [
					{ name: "Kelly", role: "qa", socket: "sockets/qa.sock" },
					{ name: "Mary", role: "po", socket: "sockets/po.sock" },
				],
				intake: { contact: "Kelly" },
			},
			"/beta/.pi/crew/crew.json",
		);
		(mutated as { members: unknown }).members = [mutated.members[1]!];
		unknown.setManifest(mutated);
		await rejectsCode(sendCrewCorrespondence(request(), unknown.deps), "unknown-contact");
	});

	test("store open and enqueue failures map to bounded storage codes", async () => {
		for (const [error, openCode, enqueueCode] of [
			[new MemberInboxStoreError("untrusted-project", "p"), "inbox-untrusted", "inbox-untrusted"],
			[new MemberInboxStoreError("untrusted-path", "p"), "inbox-untrusted", "inbox-untrusted"],
			[new MemberInboxStoreError("capacity-exceeded", "c"), "intake-storage-failed", "inbox-full"],
			[new MemberInboxStoreError("lock-conflict", "l"), "intake-storage-failed", "storage-unavailable"],
			[new MemberInboxStoreError("write-failed", "w"), "intake-storage-failed", "storage-unavailable"],
			[new Error("boom"), "intake-storage-failed", "intake-storage-failed"],
		] as const) {
			const harness = makeDeps();
			harness.setStoreError(error);
			await rejectsCode(sendCrewCorrespondence(request(), harness.deps), openCode);

			const enqueueHarness = makeDeps();
			enqueueHarness.setEnqueueError(error);
			await rejectsCode(sendCrewCorrespondence(request(), enqueueHarness.deps), enqueueCode);
		}
	});
});

describe("crew correspondence over two real layouts with contacts offline", () => {
	test("alpha (bebop) to beta (crew) and the explicit reply back", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-correspondence-"));
		try {
			const alphaRoot = path.join(root, "alpha");
			const betaRoot = path.join(root, "beta");
			const alphaManifestPath = path.join(alphaRoot, ".pi/bebop/crew.json");
			const betaManifestPath = path.join(betaRoot, ".pi/crew/crew.json");
			const writeManifest = async (manifestPath: string, input: unknown) => {
				await fs.mkdir(path.dirname(manifestPath), { recursive: true });
				await fs.writeFile(manifestPath, JSON.stringify(input), "utf8");
			};
			await writeManifest(alphaManifestPath, {
				version: 1,
				name: "Alpha Crew",
				members: [
					{ name: "Mony", role: "lead", socket: "sockets/lead.sock" },
					{ name: "Dave", role: "developer", socket: "sockets/dave.sock" },
				],
				intake: { contact: "Mony" },
			});
			await writeManifest(betaManifestPath, {
				version: 1,
				name: "Beta Crew",
				members: [
					{ name: "Kelly", role: "qa", socket: "sockets/qa.sock" },
					{ name: "Mary", role: "po", socket: "sockets/po.sock" },
				],
				intake: { contact: "Kelly" },
			});

			const deps: CrewCorrespondenceDependencies = {
				loadManifest: (manifestPath) =>
					readTrustedCrewManifest(manifestPath, projectRootOf(manifestPath), () => true),
				openStore: (options) => openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true }),
				now: () => 4242,
			};
			const alphaMembership = {
				member: { name: "Dave", role: "developer" },
				manifestPath: alphaManifestPath,
				manifest: { name: "Alpha Crew", members: [] },
			};
			const outcome = await sendCrewCorrespondence(
				{
					membership: alphaMembership,
					targetManifestPath: betaManifestPath,
					message: "Question for your crew",
					now: 4242,
				},
				deps,
			);
			assert.equal(outcome.persisted, true);
			assert.equal(outcome.contact, "Kelly");

			const kellyInbox = await openTrustedMemberInboxStore({
				manifestPath: betaManifestPath,
				projectRoot: betaRoot,
				isProjectTrusted: () => true,
				member: {
					name: "Kelly",
					role: "qa",
					socket: "sockets/qa.sock",
					socketPath: path.join(betaRoot, ".pi/crew/sockets/qa.sock"),
				},
			});
			const inbound = await kellyInbox.peekOldest();
			assert.ok(inbound, "expected a persisted inbox item for the contact");
			assert.deepEqual(inbound.payload, {
				content: "Question for your crew",
				origin: { kind: "crew", name: "Dave", role: "developer" },
				crewReturnAddress: { manifestPath: alphaManifestPath, crewName: "Alpha Crew" },
			} satisfies MessagePayload);

			const returnAddress = (inbound.payload as MessagePayload).crewReturnAddress!;
			const reply = await sendCrewCorrespondence(
				{
					membership: {
						member: { name: "Kelly", role: "qa" },
						manifestPath: betaManifestPath,
						manifest: { name: "Beta Crew", members: [] },
					},
					targetManifestPath: returnAddress.manifestPath,
					message: "Answer from Beta Crew",
					now: 4243,
				},
				deps,
			);
			assert.equal(reply.persisted, true);
			assert.equal(reply.contact, "Mony");
			assert.equal(reply.targetManifestPath, alphaManifestPath);

			const monyInbox = await openTrustedMemberInboxStore({
				manifestPath: alphaManifestPath,
				projectRoot: alphaRoot,
				isProjectTrusted: () => true,
				member: {
					name: "Mony",
					role: "lead",
					socket: "sockets/lead.sock",
					socketPath: path.join(alphaRoot, ".pi/bebop/sockets/lead.sock"),
				},
			});
			const replyItem = await monyInbox.peekOldest();
			assert.ok(replyItem, "expected a persisted reply item for the alpha contact");
			assert.deepEqual(replyItem.payload, {
				content: "Answer from Beta Crew",
				origin: { kind: "crew", name: "Kelly", role: "qa" },
				crewReturnAddress: { manifestPath: betaManifestPath, crewName: "Beta Crew" },
			} satisfies MessagePayload);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

function projectRootOf(manifestPath: string): string {
	const normalized = manifestPath.split(/[\\/]/);
	return normalized.slice(0, -3).join("/") || "/";
}
