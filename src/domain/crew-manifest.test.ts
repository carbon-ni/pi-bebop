import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CREW_MANIFEST_FILE,
	CrewManifestError,
	CrewMemberLookupError,
	lookupCrewMemberBySocketPath,
	MAX_MEMBER_DESCRIPTION_BYTES,
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

describe("crew member descriptions", () => {
	const base = { version: 1, members: [{ name: "Bob", role: "developer", socket: "sockets/dev.sock" }] };

	test("optional nonblank description parses and round-trips inline", () => {
		const result = parseCrewManifest(
			{
				...base,
				members: [
					{
						name: "Bob",
						role: "developer",
						socket: "sockets/dev.sock",
						description: "Builds domain and application changes",
					},
				],
			},
			"/repo/.pi/intray/crew.json",
		);
		assert.equal(result.members[0]!.description, "Builds domain and application changes");
		// Descriptions stay inline on the member; no new top-level shape appears.
		assert.equal(result.members[0]!.name, "Bob");
		assert.equal(result.members[0]!.socketPath, "/repo/.pi/intray/sockets/dev.sock");
	});

	test("absent description preserves the manifest unchanged (backwards compatible)", () => {
		const result = parseCrewManifest(base);
		assert.equal("description" in result.members[0]!, false);
		assert.deepEqual(Object.keys(result.members[0]!).sort(), ["name", "role", "socket", "socketPath"]);
	});

	test("strict description schema rejects blank, padded, multiline, wrong-type, NUL, and invalid Unicode", () => {
		const cases: unknown[] = [
			{ description: "" },
			{ description: "   " },
			{ description: "  padded  " },
			{ description: "line1\nline2" },
			{ description: "line1\rline2" },
			{ description: 42 },
			{ description: true },
			{ description: ["Builds"] },
			{ description: { text: "Builds" } },
			{ description: "valid\u0000description" },
			{ description: "lone surrogate \uD800 here" },
		];
		for (const descriptionField of cases) {
			assert.throws(
				() => parseCrewManifest({ ...base, members: [{ ...base.members[0], ...descriptionField }] }),
				(error: unknown) =>
					error instanceof CrewManifestError &&
					error.code === "invalid-member" &&
					error.message.includes("members[0].description"),
				`expected member-specific description rejection for ${JSON.stringify(descriptionField)}`,
			);
		}
	});

	test("description is bounded to 256 UTF-8 bytes under the named constant", () => {
		const ascii256 = "x".repeat(256);
		const ascii257 = "x".repeat(257);
		// Multi-byte UTF-8 counts bytes, not characters: 128 × 2-byte chars = 256 bytes.
		const multibyte256 = "é".repeat(128);
		const multibyte257 = "é".repeat(129);
		const makeMember = (description: string) => ({ ...base, members: [{ ...base.members[0], description }] });
		assert.equal(parseCrewManifest(makeMember(ascii256)).members[0]!.description, ascii256);
		assert.equal(parseCrewManifest(makeMember(multibyte256)).members[0]!.description, multibyte256);
		assert.throws(() => parseCrewManifest(makeMember(ascii257)), CrewManifestError);
		assert.throws(() => parseCrewManifest(makeMember(multibyte257)), CrewManifestError);
	});

	test("MAX_MEMBER_DESCRIPTION_BYTES is a named 256 constant", () => {
		assert.equal(MAX_MEMBER_DESCRIPTION_BYTES, 256);
	});

	test("multiple members may share role and description; description is never a uniqueness constraint", () => {
		const result = parseCrewManifest({
			version: 1,
			members: [
				{ name: "Bob", role: "developer", socket: "sockets/bob.sock", description: "Builds" },
				{ name: "Dave", role: "developer", socket: "sockets/dave.sock", description: "Builds" },
			],
		});
		assert.equal(result.members.length, 2);
		assert.equal(result.members[0]!.description, "Builds");
		assert.equal(result.members[1]!.description, "Builds");
	});
});

describe("crew intake manifest config", () => {
	const members = [
		{ name: "Mary", role: "po", socket: "sockets/po.sock" },
		{ name: "Tony", role: "lead", socket: "sockets/lead.sock" },
	];

	test("optional intake selects exactly one configured member by name", () => {
		const manifest = parseCrewManifest({ version: 1, members, intake: { contact: "Mary" } });
		assert.equal(manifest.intake?.contact, "Mary");
		const lead = parseCrewManifest({ version: 1, members, intake: { contact: "Tony" } });
		assert.equal(lead.intake?.contact, "Tony");
	});

	test("absent intake leaves the manifest without a contact (disabled)", () => {
		const manifest = parseCrewManifest({ version: 1, members });
		assert.equal(manifest.intake, undefined);
	});

	test("strict intake schema rejects non-objects, extra fields, and malformed contact", () => {
		const invalidIntakes: unknown[] = [
			"Mary",
			{ contact: "Mary", fallback: "Tony" },
			{},
			{ contact: 3 },
			{ contact: "   " },
			{ contact: "Mary\0evil" },
			{ contact: " Mary " },
			{ contact: "Mary", extra: true },
		];
		for (const intake of invalidIntakes) {
			assert.throws(
				() => parseCrewManifest({ version: 1, members, intake }),
				(error: unknown) => error instanceof CrewManifestError && error.code === "invalid-intake-config",
				`expected invalid-intake-config for ${JSON.stringify(intake)}`,
			);
		}
	});

	test("unknown or renamed contact is rejected at the manifest boundary", () => {
		assert.throws(
			() => parseCrewManifest({ version: 1, members, intake: { contact: "Ghost" } }, "/project/.pi/bebop/crew.json"),
			(error: unknown) => {
				assert.ok(error instanceof CrewManifestError);
				assert.equal(error.code, "invalid-intake-contact");
				assert.equal(error.manifestPath, "/project/.pi/bebop/crew.json");
				assert.deepEqual(error.validMemberNames, ["Mary", "Tony"]);
				assert.match(error.message, /Crew configuration/);
				assert.match(error.message, /intake\.contact rejected value 'Ghost'/);
				assert.match(error.message, /valid exact member names in manifest order: \[Mary, Tony\]/);
				assert.match(error.message, /Fixes:/);
				return true;
			},
		);
		assert.throws(
			() => parseCrewManifest({ version: 1, members: [members[0]!], intake: { contact: "Tony" } }),
			(error: unknown) => error instanceof CrewManifestError && error.code === "invalid-intake-contact",
		);
	});

	test("contact is resolved by exact member name, never by role", () => {
		// "po" is a role, not a member name: the manifest must reject it (no role fallback).
		assert.throws(
			() => parseCrewManifest({ version: 1, members, intake: { contact: "po" } }),
			(error: unknown) => error instanceof CrewManifestError && error.code === "invalid-intake-contact",
		);
		// A member literally named like a role resolves by name, not by its role field.
		const namedLead = parseCrewManifest({
			version: 1,
			members: [{ name: "lead", role: "po", socket: "sockets/lead.sock" }],
			intake: { contact: "lead" },
		});
		assert.equal(namedLead.intake?.contact, "lead");
	});
});
