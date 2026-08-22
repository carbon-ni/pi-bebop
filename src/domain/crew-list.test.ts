import test from "node:test";
import assert from "node:assert/strict";
import { formatCrewList } from "./index.ts";

test("formats rows in supplied manifest order without instructions or global targets", () => {
	assert.equal(
		formatCrewList("/project/.pi/crew/crew.json", [
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
