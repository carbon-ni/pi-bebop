import assert from "node:assert/strict";
import test from "node:test";
import { projectCrewRoles, selectCrewMemberByRole } from "./crew-role.ts";
import type { CrewManifest } from "./crew-manifest.ts";

const manifest = (members: Array<{ name: string; role: string; socketPath?: string }>): CrewManifest =>
	({
		version: 1,
		members: members.map((member) => ({
			name: member.name,
			role: member.role,
			socket: member.socketPath ?? `sockets/${member.name}.sock`,
			socketPath: `/project/.pi/bebop/${member.socketPath ?? `sockets/${member.name}.sock`}`,
		})),
		presence: { notifications: true },
	}) as CrewManifest;

test("selects one exact case-sensitive role and returns the configured socket", () => {
	const result = selectCrewMemberByRole(
		manifest([{ name: "Bob", role: "developer", socketPath: "sockets/custom.sock" }]),
		"developer",
	);
	assert.equal(result.kind, "match");
	if (result.kind === "match") {
		assert.equal(result.member.name, "Bob");
		assert.equal(result.member.socketPath, "/project/.pi/bebop/sockets/custom.sock");
	}
	assert.equal(
		selectCrewMemberByRole(manifest([{ name: "Bob", role: "Developer" }]), "developer").kind,
		"unknown-role",
	);
});

test("rejects empty, unknown, member-name, and duplicate roles without exposing members or paths", () => {
	assert.equal(selectCrewMemberByRole(manifest([{ name: "Bob", role: "developer" }]), "").kind, "empty-role");
	const unknown = selectCrewMemberByRole(manifest([{ name: "Bob", role: "developer" }]), "Bob");
	assert.equal(unknown.kind, "unknown-role");
	const ambiguous = selectCrewMemberByRole(
		manifest([
			{ name: "Bob", role: "developer" },
			{ name: "Sue", role: "developer" },
		]),
		"developer",
	);
	assert.deepEqual(ambiguous, { kind: "ambiguous-role", role: "developer" });
});

test("projects distinct roles in first-manifest-appearance order with manifest-level counts", () => {
	const result = projectCrewRoles(
		manifest([
			{ name: "Tony", role: "lead" },
			{ name: "Bob", role: "developer" },
			{ name: "Sue", role: "developer" },
			{ name: "Mary", role: "po" },
			{ name: "Kelly", role: "qa" },
		]),
	);
	assert.deepEqual(result, {
		roles: ["lead", "developer", "po", "qa"],
		roleCount: 4,
		memberCount: 5,
	});
});

test("role projection is exact and case-sensitive: repeated values dedupe, differing case does not", () => {
	const result = projectCrewRoles(
		manifest([
			{ name: "A", role: "Dev" },
			{ name: "B", role: "dev" },
			{ name: "C", role: "Dev" },
		]),
	);
	assert.deepEqual(result.roles, ["Dev", "dev"]);
	assert.equal(result.roleCount, 2);
	assert.equal(result.memberCount, 3);
});

test("role projection is deterministic and pure: same manifest yields identical output, empty members is a stable empty projection", () => {
	const input = manifest([
		{ name: "Tony", role: "lead" },
		{ name: "Mary", role: "po" },
	]);
	assert.deepEqual(projectCrewRoles(input), projectCrewRoles(input));
	// An empty member list is invalid per manifest parsing rules; the pure
	// projection still degrades deterministically rather than throwing.
	assert.deepEqual(projectCrewRoles(manifest([])), { roles: [], roleCount: 0, memberCount: 0 });
});

test("unknown roles expose at most eight distinct roles in manifest order and exact omission count", () => {
	const roles = ["lead", "developer", "qa", "po", "ops", "design", "security", "docs", "research", "developer"];
	const result = selectCrewMemberByRole(
		manifest(roles.map((role, index) => ({ name: `m${index}`, role }))),
		"missing",
	);
	assert.deepEqual(result, {
		kind: "unknown-role",
		role: "missing",
		availableRoles: ["lead", "developer", "qa", "po", "ops", "design", "security", "docs"],
		omittedRoleCount: 1,
	});
	assert.deepEqual(selectCrewMemberByRole(manifest([]), "missing"), {
		kind: "unknown-role",
		role: "missing",
		availableRoles: [],
		omittedRoleCount: 0,
	});
});
