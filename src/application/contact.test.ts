import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { submitContact, ContactError, MAX_CREW_INTAKE_FILE_BYTES } from "./contact.ts";

async function fixture(intake: unknown = { contact: "Mary" }, includeIntake = true) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-contact-"));
	const layout = path.join(root, ".pi", "bebop");
	await fs.mkdir(path.join(layout, "instructions"), { recursive: true, mode: 0o700 });
	await fs.writeFile(
		path.join(layout, "crew.json"),
		JSON.stringify({
			version: 1,
			crew: { id: "alpha", displayName: "Alpha" },
			...(includeIntake ? { intake } : {}),
			presence: { notifications: true },
			members: [
				{ name: "Mary", role: "po", socket: "sockets/Mary.sock" },
				{ name: "Dev", role: "developer", socket: "sockets/Dev.sock" },
			],
		}),
		{ mode: 0o600 },
	);
	return { root, layout, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("contact publishes one unverified Intake file without a joined session", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const first = await submitContact({ projectRoot: harness.root, content: "Feedback ✅" });
	assert.equal(first.state, "published");
	assert.equal(first.contact.name, "Mary");
	assert.equal(first.contact.role, "po");
	assert.deepEqual(first.crew, { id: "alpha", displayName: "Alpha" });
	const filename = `contact-${first.submissionId}.md`;
	assert.equal(await fs.readFile(path.join(harness.layout, "intake", "new", filename), "utf8"), "Feedback ✅");
	const repeated = await submitContact({ projectRoot: harness.root, content: "Feedback ✅" });
	assert.equal(repeated.state, "already-published");
	assert.equal((await fs.readdir(path.join(harness.layout, "intake", "new"))).length, 1);
});

test("contact rejects disabled Intake and missing Crew projects with actionable codes", async (t) => {
	const disabled = await fixture(undefined, false);
	t.after(disabled.cleanup);
	await assert.rejects(
		submitContact({ projectRoot: disabled.root, content: "hello" }),
		(error: unknown) => error instanceof ContactError && error.code === "external-intake-disabled",
	);
	const empty = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-no-project-"));
	t.after(() => fs.rm(empty, { recursive: true, force: true }));
	await assert.rejects(
		submitContact({ projectRoot: empty, content: "hello" }),
		(error: unknown) => error instanceof ContactError && error.code === "not-a-crew-project",
	);
});

test("contact enforces UTF-8 size and NUL boundaries before publication", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await assert.rejects(
		submitContact({ projectRoot: harness.root, content: "\0" }),
		(error: unknown) => error instanceof ContactError && error.code === "invalid-payload",
	);
	await assert.rejects(
		submitContact({ projectRoot: harness.root, content: "x".repeat(MAX_CREW_INTAKE_FILE_BYTES + 1) }),
		(error: unknown) => error instanceof ContactError && error.code === "invalid-payload",
	);
	await assert.rejects(fs.access(path.join(harness.layout, "intake", "new")));
});

test("contact rejects control-heavy content that would overflow the serialized Inbox payload", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const content = `${"\n".repeat(500_000)}x`;
	await assert.rejects(
		submitContact({ projectRoot: harness.root, content }),
		(error: unknown) => error instanceof ContactError && error.code === "invalid-payload",
	);
	await assert.rejects(fs.access(path.join(harness.layout, "intake", "new")));
});
