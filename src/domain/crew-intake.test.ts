import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseCrewManifest, type CrewManifest } from "./crew-manifest.ts";
import {
	canonicalizeCrewManifestPath,
	CrewIntakeError,
	createCrewCorrespondencePayload,
	createExternalIntakePayload,
	isExternalIntakeAck,
	resolveIntakeContact,
} from "./crew-intake.ts";

const members = [
	{ name: "Mary", role: "po", socket: "sockets/po.sock" },
	{ name: "Tony", role: "lead", socket: "sockets/lead.sock" },
	{ name: "Bob", role: "dev", socket: "sockets/dev.sock" },
];

const manifestWith = (intake?: unknown): CrewManifest =>
	parseCrewManifest(
		intake === undefined ? { version: 1, members } : { version: 1, members, intake },
		"/project/.pi/bebop/crew.json",
	);

describe("resolveIntakeContact", () => {
	test("resolves the exact configured member by name when enabled", () => {
		const resolution = resolveIntakeContact(manifestWith({ contact: "Mary" }));
		assert.equal(resolution.enabled, true);
		if (resolution.enabled) {
			assert.equal(resolution.contact.name, "Mary");
			assert.equal(resolution.contact.role, "po");
			assert.equal(resolution.contact.socketPath, "/project/.pi/bebop/sockets/po.sock");
		}
	});

	test("no contact yields explicit external-intake-disabled with no fallback", () => {
		const resolution = resolveIntakeContact(manifestWith());
		assert.deepEqual(resolution, { enabled: false, reason: "external-intake-disabled" });
	});

	test("disabled even when a lead/po/first member exists: no implicit fallback", () => {
		// Mary(po)/Tony(lead) exist, but without a configured contact intake stays disabled.
		const resolution = resolveIntakeContact(manifestWith());
		assert.equal(resolution.enabled, false);
	});

	test("unknown contact on a manifest is a defensive contract violation", () => {
		const malformed = parseCrewManifest({ version: 1, members }, "/project/.pi/bebop/crew.json");
		(malformed as { intake?: { contact: string } }).intake = { contact: "Ghost" };
		assert.throws(
			() => resolveIntakeContact(malformed),
			(error: unknown) => error instanceof CrewIntakeError && error.code === "unknown-contact",
		);
	});

	test("contact identity and inbox location come only from the validated manifest", () => {
		const resolution = resolveIntakeContact(manifestWith({ contact: "Bob" }));
		assert.equal(resolution.enabled, true);
		if (resolution.enabled) {
			assert.equal(resolution.contact.socketPath, "/project/.pi/bebop/sockets/dev.sock");
			assert.equal(resolution.contact.name, "Bob");
		}
	});
});

describe("createExternalIntakePayload", () => {
	test("builds a one-way message with claimed, unverified external origin", () => {
		const payload = createExternalIntakePayload({
			label: "ci-job-42",
			content: "Please review the plan",
			instructions: ["Triage", "Forward"],
		});
		assert.deepEqual(payload.origin, { kind: "external", label: "ci-job-42" });
		assert.equal(payload.content, "Please review the plan");
		assert.deepEqual(payload.instructions, ["Triage", "Forward"]);
		// One-way: no reply route and no response contract on the payload.
		assert.equal(payload.replyTo, undefined);
		assert.ok(!JSON.stringify(payload).includes("replyTo"));
	});

	test("rejects blank, NUL, or oversized content and labels", () => {
		for (const bad of [
			{ label: "", content: "x" },
			{ label: "x", content: "   " },
			{ label: "x", content: "nul\0byte" },
			{ label: "x", content: "x", instructions: [""] },
			{ label: "x", content: "x", instructions: Array(33).fill("i") },
		]) {
			assert.throws(
				() => createExternalIntakePayload(bad as never),
				(error: unknown) => error instanceof CrewIntakeError && error.code === "invalid-payload",
			);
		}
	});
});

describe("ExternalIntakeAck contract", () => {
	test("one-way persisted acknowledgement has no reply route or promised response", () => {
		const ack = {
			ok: true,
			itemId: "inbox-0-abc",
			persisted: true,
			contact: "Mary",
			contactRole: "po",
		};
		assert.equal(isExternalIntakeAck(ack), true);
		assert.ok(!JSON.stringify(ack).includes("reply"));
		assert.ok(!JSON.stringify(ack).includes("sessionId"));
	});

	test("rejects acknowledgements that carry reply routing or drop persistence", () => {
		assert.equal(
			isExternalIntakeAck({
				ok: true,
				itemId: "i",
				persisted: true,
				contact: "Mary",
				contactRole: "po",
				replyTo: {},
			}),
			false,
		);
		assert.equal(isExternalIntakeAck({ ok: true, itemId: "i", persisted: false, contact: "Mary" }), false);
		assert.equal(isExternalIntakeAck({ ok: true, itemId: "i", contact: "Mary", contactRole: "po" }), false);
		assert.equal(isExternalIntakeAck({ ok: true, itemId: "i", persisted: true, contact: "Mary" }), false);
		assert.equal(isExternalIntakeAck(null), false);
	});
});

describe("ExternalIntakeAck crewName", () => {
	test("accepts an optional bounded crew label alongside persisted-only fields", () => {
		const base = {
			ok: true,
			itemId: "inbox-0-abc",
			persisted: true as const,
			contact: "Kelly",
			contactRole: "qa",
		};
		assert.equal(isExternalIntakeAck(base), true);
		assert.equal(isExternalIntakeAck({ ...base, crewName: "Beta Crew" }), true);
	});

	test("rejects invalid crew labels and reply routing fields", () => {
		const base = {
			ok: true,
			itemId: "inbox-0-abc",
			persisted: true as const,
			contact: "Kelly",
			contactRole: "qa",
		};
		for (const crewName of ["", " padded ", 1, null, "x".repeat(257), "Alpha\nCrew", "🚩".repeat(65)]) {
			assert.equal(isExternalIntakeAck({ ...base, crewName }), false, JSON.stringify(crewName));
		}
		assert.equal(isExternalIntakeAck({ ...base, crewName: "🚩".repeat(64) }), true);
		assert.equal(isExternalIntakeAck({ ...base, crewName: "Beta Crew", response: "x" }), false);
	});
});

describe("createCrewCorrespondencePayload", () => {
	const source = {
		memberName: "Dave",
		memberRole: "developer",
		manifestPath: "/projects/alpha/.pi/bebop/crew.json",
	};

	test("builds a one-way payload with claimed crew origin and structured crew return address", () => {
		const payload = createCrewCorrespondencePayload({
			source: { ...source, crewName: "Alpha Crew" },
			content: "Question for your crew",
			instructions: ["Reply through send_to_crew"],
		});
		assert.deepEqual(payload.origin, { kind: "crew", name: "Dave", role: "developer" });
		assert.deepEqual(payload.crewReturnAddress, {
			manifestPath: "/projects/alpha/.pi/bebop/crew.json",
			crewName: "Alpha Crew",
		});
		assert.deepEqual(payload.instructions, ["Reply through send_to_crew"]);
		assert.equal("replyTo" in payload, false);
	});

	test("omits the crew label when the source manifest has no display name", () => {
		const payload = createCrewCorrespondencePayload({ source, content: "hi" });
		assert.deepEqual(payload.crewReturnAddress, { manifestPath: source.manifestPath });
	});

	test("rejects invalid content and invalid return addresses deterministically", () => {
		for (const bad of [
			{ content: " " },
			{ content: "x", source: { ...source, manifestPath: "relative/crew.json" } },
			{ content: "x", source: { ...source, memberName: "" } },
			{ content: "x", source: { ...source, crewName: " padded " } },
		] as const) {
			assert.throws(
				() => createCrewCorrespondencePayload({ source: bad.source ?? source, content: bad.content }),
				/invalid/,
			);
		}
	});
});

describe("canonicalizeCrewManifestPath", () => {
	test("lexically canonicalizes absolute POSIX paths without filesystem IO", () => {
		assert.equal(canonicalizeCrewManifestPath("/a/.pi/bebop/crew.json"), "/a/.pi/bebop/crew.json");
		assert.equal(canonicalizeCrewManifestPath("/a//b/.pi/bebop/./crew.json"), "/a/b/.pi/bebop/crew.json");
		assert.equal(canonicalizeCrewManifestPath("/a/x/../.pi/bebop/crew.json"), "/a/.pi/bebop/crew.json");
		assert.equal(canonicalizeCrewManifestPath("/a/.pi/bebop/crew.json/"), "/a/.pi/bebop/crew.json");
	});

	test("returns null for relative, empty, NUL, and root-escaping paths", () => {
		assert.equal(canonicalizeCrewManifestPath("a/.pi/bebop/crew.json"), null);
		assert.equal(canonicalizeCrewManifestPath(""), null);
		assert.equal(canonicalizeCrewManifestPath("/a\u0000/crew.json"), null);
		assert.equal(canonicalizeCrewManifestPath("/../crew.json"), null);
		assert.equal(canonicalizeCrewManifestPath("/a/../../crew.json"), null);
	});
});

describe("createCrewCorrespondencePayload canonical return address", () => {
	const source = {
		memberName: "Dave",
		memberRole: "developer",
		manifestPath: "/alpha/.pi/bebop/crew.json",
	};

	test("canonicalizes a valid but non-canonical source path", () => {
		const payload = createCrewCorrespondencePayload({
			source: { ...source, manifestPath: "/alpha//proj/../.pi/bebop/./crew.json" },
			content: "hi",
		});
		assert.equal(payload.crewReturnAddress?.manifestPath, "/alpha/.pi/bebop/crew.json");
	});

	test("rejects source paths that cannot be canonicalized to an absolute path", () => {
		for (const bad of ["alpha/.pi/bebop/crew.json", "/../crew.json", "/a\u0000/crew.json", ""]) {
			assert.throws(
				() => createCrewCorrespondencePayload({ source: { ...source, manifestPath: bad }, content: "hi" }),
				/invalid/,
			);
		}
	});
});
