import test from "node:test";
import assert from "node:assert/strict";
import { formatCrewRoster } from "./index.ts";

test("formats rows in supplied manifest order without instructions or global targets", () => {
	assert.equal(
		formatCrewRoster("/project/.pi/crew/crew.json", [
			{
				member: {
					name: "lead",
					role: "lead",
					socket: "sockets/lead.sock",
					socketPath: "/project/.pi/crew/sockets/lead.sock",
					instructions: "secret",
				},
				status: "current",
			},
		]),
		"Crew: /project/.pi/crew/crew.json\nMembers (1):\n- lead (lead) — current — /project/.pi/crew/sockets/lead.sock",
	);
});

test("formats optional description on the same deterministic row, keeping status and endpoint positions", () => {
	assert.equal(
		formatCrewRoster("/project/.pi/crew/crew.json", [
			{
				member: {
					name: "Bob",
					role: "developer",
					socket: "sockets/dev.sock",
					socketPath: "/project/.pi/crew/sockets/dev.sock",
					description: "Builds domain and application changes",
				},
				status: "current",
			},
			{
				member: {
					name: "Kelly",
					role: "qa",
					socket: "sockets/qa.sock",
					socketPath: "/project/.pi/crew/sockets/qa.sock",
				},
				status: "offline",
			},
		]),
		"Crew: /project/.pi/crew/crew.json\nMembers (2):\n- Bob (developer) — current — Builds domain and application changes — /project/.pi/crew/sockets/dev.sock\n- Kelly (qa) — offline — /project/.pi/crew/sockets/qa.sock",
	);
});

test("roster keeps descriptions out of status and keeps status/endpoint tokens exact", () => {
	const rows = [
		{
			member: {
				name: "Dave",
				role: "developer",
				socket: "sockets/dave.sock",
				socketPath: "/project/.pi/crew/sockets/dave.sock",
				description: "Focuses on infra",
			},
			status: "online" as const,
		},
	];
	const rendered = formatCrewRoster("/project/.pi/crew/crew.json", rows);
	assert.match(rendered, /— online —/);
	assert.match(rendered, /— Focuses on infra —/);
	assert.match(rendered, /— \/project\/\.pi\/crew\/sockets\/dave\.sock$/);
	assert.doesNotMatch(rendered, /current|offline/);
});

test("roster renders the crew name line only when a name is provided", () => {
	const rows = [
		{
			member: { name: "Dave", role: "developer", socket: "sockets/dave.sock", socketPath: "/p/dave.sock" },
			status: "current" as const,
		},
	];
	assert.equal(
		formatCrewRoster("/project/.pi/crew/crew.json", rows, "Alpha Crew"),
		"Crew: /project/.pi/crew/crew.json\nName: Alpha Crew\nMembers (1):\n- Dave (developer) — current — /p/dave.sock",
	);
	assert.equal(
		formatCrewRoster("/project/.pi/crew/crew.json", rows),
		"Crew: /project/.pi/crew/crew.json\nMembers (1):\n- Dave (developer) — current — /p/dave.sock",
	);
});
