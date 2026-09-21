import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createFilesystemCrewIntakeController } from "./filesystem-crew-intake.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";

async function fixture(contact = "Mary") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filesystem-crew-intake-"));
	const layout = path.join(root, ".pi", "bebop");
	const sockets = path.join(layout, "sockets");
	await fs.mkdir(sockets, { recursive: true, mode: 0o700 });
	const manifestPath = path.join(layout, "crew.json");
	const members = [
		{ name: "Mary", role: "po", socket: "sockets/Mary.sock" },
		{ name: "Bob", role: "dev", socket: "sockets/Bob.sock" },
	];
	await fs.writeFile(manifestPath, JSON.stringify({ version: 1, members, intake: { contact } }), { mode: 0o600 });
	const membership = {
		manifestPath,
		member: {
			name: contact,
			role: contact === "Mary" ? "po" : "dev",
			socketPath: path.join(sockets, `${contact}.sock`),
		},
	};
	return { root, layout, manifestPath, membership, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function controllerFor(harness: Awaited<ReturnType<typeof fixture>>, member = harness.membership) {
	let current: typeof member | null = member;
	let accepted = 0;
	const errors: string[] = [];
	const controller = createFilesystemCrewIntakeController({
		getMembership: () => current,
		isProjectTrusted: () => true,
		onAccepted: () => {
			accepted += 1;
		},
		onError: (code) => errors.push(code),
		quiescenceMs: 0,
	});
	return {
		controller,
		errors,
		get accepted() {
			return accepted;
		},
		set current(value: typeof member | null) {
			current = value;
		},
	};
}

async function storeFor(harness: Awaited<ReturnType<typeof fixture>>, member = harness.membership.member) {
	return openTrustedMemberInboxStore({
		manifestPath: harness.manifestPath,
		projectRoot: harness.root,
		isProjectTrusted: () => true,
		member: {
			name: member.name,
			role: member.role,
			socketPath: member.socketPath,
		},
	});
}

test("filesystem intake resolves the exact contact, persists, and retains processed evidence", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	await intake.controller.scan();
	const newDir = path.join(harness.layout, "intake", "new");
	await fs.writeFile(path.join(newDir, "2026-09-20-login.md"), "opaque external context\nwithout classification");
	const result = await intake.controller.scan();
	assert.deepEqual(result, { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	assert.equal(intake.accepted, 1);
	assert.equal(await (await storeFor(harness)).count(), 1);
	assert.equal(
		await fs.readFile(path.join(harness.layout, "intake", "processed", "2026-09-20-login.md"), "utf8"),
		"opaque external context\nwithout classification",
	);
	assert.equal(intake.errors.length, 0);
	intake.controller.close();
});

test("non-contact membership leaves ready files untouched", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const bob = {
		manifestPath: harness.manifestPath,
		member: { name: "Bob", role: "dev", socketPath: path.join(harness.layout, "sockets", "Bob.sock") },
	};
	const intake = controllerFor(harness, bob);
	t.after(() => intake.controller.close());
	await fs.mkdir(path.join(harness.layout, "intake", "new"), { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(harness.layout, "intake", "new", "later.txt"), "wait for Mary");
	assert.deepEqual(await intake.controller.scan(), { state: "skipped", reason: "not-contact" });
	assert.equal(await fs.readFile(path.join(harness.layout, "intake", "new", "later.txt"), "utf8"), "wait for Mary");
	intake.controller.close();
});

test("manifest contact changes invalidate the active intake owner", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	await intake.controller.scan();
	await fs.writeFile(path.join(harness.layout, "intake", "new", "later.md"), "wait for the new contact");
	await fs.writeFile(
		harness.manifestPath,
		JSON.stringify({
			version: 1,
			members: [
				{ name: "Mary", role: "po", socket: "sockets/Mary.sock" },
				{ name: "Bob", role: "dev", socket: "sockets/Bob.sock" },
			],
			intake: { contact: "Bob" },
		}),
	);
	assert.deepEqual(await intake.controller.scan(), { state: "skipped", reason: "not-contact" });
	assert.equal(
		await fs.readFile(path.join(harness.layout, "intake", "new", "later.md"), "utf8"),
		"wait for the new contact",
	);
});

test("invalid UTF-8 is retained in failed with a bounded reason", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	await fs.mkdir(path.join(harness.layout, "intake", "new"), { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(harness.layout, "intake", "new", "broken.txt"), Buffer.from([0xc3, 0x28]));
	const result = await intake.controller.scan();
	assert.deepEqual(result, { state: "scanned", accepted: 0, failed: 1, remaining: 0 });
	assert.deepEqual(
		await fs.readFile(path.join(harness.layout, "intake", "failed", "broken.txt")),
		Buffer.from([0xc3, 0x28]),
	);
	const reason = JSON.parse(
		await fs.readFile(path.join(harness.layout, "intake", "failed", "broken.txt.reason.json"), "utf8"),
	);
	assert.equal(reason.reason, "invalid-utf8");
	intake.controller.close();
});
