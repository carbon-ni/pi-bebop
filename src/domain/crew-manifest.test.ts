import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CREW_MANIFEST_FILE,
	CrewManifestError,
	CrewMemberLookupError,
	lookupCrewMemberBySocketPath,
	parseCrewManifest,
	resolveCrewMemberSocketPath,
	resolveCrewMemberBySocketPath,
} from "./index.ts";

describe("crew manifest", () => {
	test("parses a valid manifest and resolves member instructions", () => {
		const result = parseCrewManifest(
			{
				version: 1,
				members: [
					{ name: "dev", role: "developer", socket: "sockets/dev.sock", instructions: "Implement tasks" },
				],
			},
			"/repo/.pi/intray/crew.json",
		);

		assert.equal(result.version, 1);
		assert.deepEqual(result.members[0], {
			name: "dev",
			role: "developer",
			socket: "sockets/dev.sock",
			instructions: "Implement tasks",
			socketPath: "/repo/.pi/intray/sockets/dev.sock",
		});
		assert.equal(
			resolveCrewMemberSocketPath(result.members[0], "/repo/.pi/intray/crew.json"),
			"/repo/.pi/intray/sockets/dev.sock",
		);
		assert.equal(DEFAULT_CREW_MANIFEST_FILE, "crew.json");
	});

	test("rejects invalid versions, member values, roles, instructions, and sockets", () => {
		const cases: unknown[] = [
			{ version: 2, members: [] },
			{ version: 1, members: [{ name: "", role: "developer", socket: "dev.sock" }] },
			{ version: 1, members: [{ name: "dev", role: "", socket: "dev.sock" }] },
			{ version: 1, members: [{ name: "dev", role: "developer", socket: "dev.sock", instructions: 3 }] },
			{ version: 1, members: [{ name: "dev", role: "developer", socket: "dev.sock", instructions: "   \n" }] },
			{
				version: 1,
				members: [{ name: "dev", role: "developer", socket: "dev.sock", instructions: "valid\0invalid" }],
			},
			{ version: 1, members: [{ name: "dev", role: "developer", socket: "" }] },
			{ version: 1, members: [{ name: "dev", role: "developer", socket: "/tmp/dev.sock" }] },
			{ version: 1, members: [{ name: "dev", role: "developer", socket: "../../dev.sock" }] },
		];

		for (const value of cases) {
			assert.throws(
				() => parseCrewManifest(value),
				(error: unknown) => error instanceof CrewManifestError,
			);
		}
	});

	test("parses one file-backed instruction source and rejects unsafe or conflicting sources", () => {
		const result = parseCrewManifest(
			{
				version: 1,
				members: [
					{
						name: "dev",
						role: "developer",
						socket: "sockets/dev.sock",
						instructionsFile: "instructions/dev.md",
					},
				],
			},
			"/repo/.pi/bebop/crew.json",
		);
		assert.equal(result.members[0].instructionsFile, "instructions/dev.md");
		for (const instructionsFile of [
			"/tmp/dev.md",
			"../dev.md",
			"instructions/../dev.md",
			"",
			"instructions/\0.md",
		]) {
			assert.throws(
				() =>
					parseCrewManifest(
						{
							version: 1,
							members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock", instructionsFile }],
						},
						"/repo/.pi/bebop/crew.json",
					),
				(error: unknown) => error instanceof CrewManifestError && error.code === "invalid-instructions-file",
			);
		}
		assert.throws(
			() =>
				parseCrewManifest({
					version: 1,
					members: [
						{
							name: "dev",
							role: "developer",
							socket: "sockets/dev.sock",
							instructions: "inline",
							instructionsFile: "instructions/dev.md",
						},
					],
				}),
			/only one/,
		);
	});

	test("rejects absolute and escaping sockets outside the crew namespace", () => {
		for (const socket of ["/tmp/dev.sock", "../../dev.sock", "sockets/../../dev.sock"]) {
			assert.throws(
				() =>
					parseCrewManifest(
						{
							version: 1,
							members: [{ name: "dev", role: "developer", socket }],
						},
						"/repo/.pi/intray/crew.json",
					),
				(error: unknown) => error instanceof CrewManifestError && error.code === "invalid-socket-path",
			);
		}
	});

	test("rejects duplicate names and duplicate normalized socket paths", () => {
		assert.throws(
			() =>
				parseCrewManifest({
					version: 1,
					members: [
						{ name: "dev", role: "developer", socket: "sockets/dev.sock" },
						{ name: "dev", role: "reviewer", socket: "sockets/reviewer.sock" },
					],
				}),
			/duplicate member name/i,
		);

		assert.throws(
			() =>
				parseCrewManifest(
					{
						version: 1,
						members: [
							{ name: "dev", role: "developer", socket: "sockets/./dev.sock" },
							{ name: "review", role: "reviewer", socket: "sockets/dev.sock" },
						],
					},
					"/repo/.pi/intray/crew.json",
				),
			/duplicate socket path/i,
		);
	});

	test("reverse lookup is authoritative and reports no match or duplicate paths", () => {
		const manifest = parseCrewManifest(
			{
				version: 1,
				members: [
					{ name: "dev", role: "developer", socket: "sockets/dev.sock" },
					{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
				],
			},
			"/repo/.pi/intray/crew.json",
		);

		assert.equal(lookupCrewMemberBySocketPath(manifest, "/repo/.pi/intray/sockets/unknown.sock").kind, "no-match");
		assert.equal(lookupCrewMemberBySocketPath(manifest, "/repo/.pi/intray/sockets/dev.sock").member.name, "dev");
		assert.equal(
			lookupCrewMemberBySocketPath(manifest, "/repo/.pi/intray/sockets/../sockets/dev.sock").member.name,
			"dev",
		);
		assert.throws(
			() => resolveCrewMemberBySocketPath(manifest, "/repo/.pi/intray/sockets/unknown.sock"),
			(error: unknown) => error instanceof CrewMemberLookupError && error.code === "no-match",
		);
	});
});
