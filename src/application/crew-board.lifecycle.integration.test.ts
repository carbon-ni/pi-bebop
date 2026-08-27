import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCrewManifest } from "../domain/index.ts";
import { openTrustedCrewBoardStore } from "../infra/crew-board-store.ts";
import type { Membership } from "../infra/membership-runtime.ts";
import { leaveCrewPost, readCrewBoard } from "./crew-board.ts";

const roster = [
	{ name: "Mary", role: "po" },
	{ name: "Dave", role: "dev" },
	{ name: "Kelly", role: "qa" },
	{ name: "Lina", role: "lead" },
];

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-board-lifecycle-"));
	const manifestPath = path.join(root, ".pi", "bebop", "crew.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	const document = {
		version: 1,
		members: roster.map((member) => ({ ...member, socket: `sockets/${member.name.toLowerCase()}.sock` })),
	};
	await fs.writeFile(manifestPath, JSON.stringify(document));
	const manifest = parseCrewManifest(document, manifestPath);
	const membership = (name: string): Membership => {
		const member = manifest.members.find((candidate) => candidate.name === name);
		assert.ok(member);
		return { manifestPath, socketPath: member.socketPath, globalSocketPath: `/tmp/${name}.sock`, member, manifest };
	};
	const dependencies = (current: Membership) => ({
		isProjectTrusted: () => true,
		getCurrentMembership: () => current,
		openStore: openTrustedCrewBoardStore,
	});
	return { root, membership, dependencies };
}

test("four distinct Roles share one Board through join/rejoin capability without delivery state", async (t) => {
	const h = await fixture();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	const memberships = roster.map((member) => h.membership(member.name));

	await Promise.all(
		memberships.map((member, index) =>
			leaveCrewPost(
				{
					membership: member,
					operationId: `lifecycle-${member.member.name}`,
					message: `post from ${member.member.name}`,
					now: index + 1,
				},
				h.dependencies(member),
			),
		),
	);
	for (const member of memberships) {
		const page = await readCrewBoard({ membership: member, limit: 100 }, h.dependencies(member));
		assert.equal(page.posts.length, roster.length);
		assert.deepEqual(
			new Set(page.posts.map((post) => post.author.name)),
			new Set(roster.map((entry) => entry.name)),
		);
	}

	const rejoined = h.membership("Kelly");
	const replay = await readCrewBoard({ membership: rejoined, limit: 100 }, h.dependencies(rejoined));
	assert.equal(replay.posts.length, roster.length);
	assert.equal((await fs.stat(path.join(h.root, ".pi", "bebop", "board", "posts"))).isDirectory(), true);
});
