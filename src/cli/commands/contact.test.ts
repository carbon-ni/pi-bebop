import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
	buildContactCommand,
	readContactCommand,
	runContactCommand,
	type ContactCliDependencies,
	type ContactCliOptions,
} from "./contact.ts";
import { ContactError } from "../../application/contact.ts";
import { UsageError } from "../support/arguments.ts";
import { writeOutcome, type CliOutcome } from "../support/output.ts";
import type { CliContext } from "../support/context.ts";

function context(input = new PassThrough()): CliContext {
	return { cwd: "/project", input, signal: new AbortController().signal };
}

function parse(tokens: readonly string[]): ContactCliOptions {
	const command = buildContactCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return readContactCommand(command);
}

function render(outcome: CliOutcome): { exit: number; text: string } {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => (text += chunk));
	const exit = writeOutcome(output, new PassThrough(), outcome);
	return { exit, text };
}

const publication = {
	submissionId: "a".repeat(64),
	state: "published" as const,
	bytes: 7,
	crew: { id: "alpha", displayName: "Alpha" },
	contact: { name: "Mary", role: "po" },
};

function deps(overrides: Partial<ContactCliDependencies> = {}): ContactCliDependencies {
	return {
		submit: async () => publication,
		readStdin: async () => "stdin feedback",
		...overrides,
	};
}

test("contact parses exactly one message source", () => {
	assert.equal(parse(["--message", "hello"]).message, "hello");
	assert.equal(parse(["--stdin"]).stdin, true);
	assert.throws(() => parse([]), UsageError);
	assert.throws(() => parse(["--message", "hello", "--stdin"]), UsageError);
	assert.throws(() => parse(["--message", " "]), UsageError);
});

test("contact publishes feedback and reports persistence without delivery claims", async () => {
	let request: unknown;
	const outcome = await runContactCommand(
		{ command: "contact", message: "hello", stdin: false, format: "text" },
		context(),
		deps({ submit: async (value) => ((request = value), publication) }),
	);
	assert.deepEqual(request, { projectRoot: "/project", content: "hello" });
	const rendered = render(outcome);
	assert.equal(rendered.exit, 0);
	assert.match(rendered.text, /Published to Crew Intake/);
	assert.doesNotMatch(rendered.text, /Delivered|has been read|was acted on/);
});

test("contact reads bounded stdin and returns stable operational errors", async () => {
	const input = new PassThrough();
	const outcome = await runContactCommand(
		{ command: "contact", stdin: true, format: "json" },
		context(input),
		deps({
			readStdin: async () => "from stdin",
			submit: async ({ content }) => {
				assert.equal(content, "from stdin");
				throw new ContactError("not-a-crew-project", "no trusted project");
			},
		}),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") {
		assert.equal(outcome.result.error?.code, "not-a-crew-project");
		assert.equal(outcome.result.status, "error");
	}
});
