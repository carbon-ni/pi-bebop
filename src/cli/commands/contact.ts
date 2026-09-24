import { Command } from "commander";
import {
	submitContact,
	ContactError,
	MAX_CREW_INTAKE_FILE_BYTES,
	type ContactPublication,
} from "../../application/contact.ts";
import { UsageError, type CliFormat } from "../support/arguments.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";
import { errorResult } from "../support/errors.ts";
import type { CliContext } from "../support/context.ts";
import type { CliOutcome } from "../support/output.ts";
import { readStdinMessage } from "../support/message-input.ts";

const FORMATS: readonly CliFormat[] = ["toon", "json", "text"];

function isCliFormat(value: string): value is CliFormat {
	return (FORMATS as readonly string[]).includes(value);
}

function validateContent(value: string, source: string): void {
	if (value.length === 0 || value.trim().length === 0)
		throw new UsageError(`--${source} requires non-empty feedback`);
	if (value.includes("\0")) throw new UsageError(`--${source} must not contain NUL bytes`);
	if (Buffer.byteLength(value, "utf8") > MAX_CREW_INTAKE_FILE_BYTES)
		throw new UsageError(`--${source} exceeds the ${MAX_CREW_INTAKE_FILE_BYTES}-byte Intake limit`);
}

export interface ContactCliOptions {
	readonly command: "contact";
	readonly message?: string;
	readonly stdin: boolean;
	readonly format: CliFormat;
}

export function buildContactCommand(): Command {
	return new Command("contact")
		.description("Leave durable feedback for this project's Crew contact; no joined session required")
		.option("--message <text>", "Feedback text")
		.option("--stdin", "Read feedback from stdin")
		.option("--format <format>", "Output format: text (default), toon, or json", defaultFormatForCommand("contact"))
		.addHelpText(
			"after",
			[
				"",
				"Publish one unverified, one-way message to this trusted project's local Crew Intake.",
				"No joined session, Crew ID, member socket, Guest admission, or live PO is required.",
				"The manifest-authored intake.contact chooses the recipient; a joined member",
				"must eventually ingest the file. Success means Intake-published only — never",
				"read, delivered, answered, or acted on. Remote/no-shared-filesystem contact",
				"is unsupported.",
				"",
				"Examples:",
				'  bebop contact --message "The acceptance wording needs clarification."',
				"  printf '%s' \"Feedback\" | bebop contact --stdin",
				"",
				"Setup/recovery: run `bebop crew init`, review intake.contact, and read",
				"`.pi/bebop/intake/AGENTS.md`. Run from the Crew project directory.",
			].join("\n"),
		);
}

export function readContactCommand(command: Command): ContactCliOptions {
	const options = command.opts<{ message?: string; stdin?: boolean; format?: string }>();
	const format = options.format ?? defaultFormatForCommand("contact");
	if (!isCliFormat(format))
		throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
	const stdin = options.stdin === true;
	if ((options.message === undefined) === !stdin)
		throw new UsageError("Choose exactly one feedback source: --message <text> or --stdin");
	if (options.message !== undefined) validateContent(options.message, "message");
	return {
		command: "contact",
		...(options.message === undefined ? {} : { message: options.message }),
		stdin,
		format,
	};
}

export interface ContactCliDependencies {
	readonly submit: typeof submitContact;
	readonly readStdin: typeof readStdinMessage;
}

export const defaultContactCliDependencies: ContactCliDependencies = {
	submit: submitContact,
	readStdin: readStdinMessage,
};

function contactResponse(publication: ContactPublication): string {
	const contact = `${publication.contact.name} (${publication.contact.role})`;
	if (publication.state === "already-published")
		return `Already published to Crew Intake for ${contact}. This does not mean read or acted on.`;
	return `Published to Crew Intake for ${contact}. No delivery, reading, or action is implied.`;
}

export async function runContactCommand(
	options: ContactCliOptions,
	context: CliContext,
	deps: ContactCliDependencies = defaultContactCliDependencies,
): Promise<CliOutcome> {
	let content = options.message;
	if (options.stdin) {
		try {
			content = await deps.readStdin(context.input, context.signal, MAX_CREW_INTAKE_FILE_BYTES);
		} catch (error) {
			return {
				kind: "result",
				result: errorResult(
					`Contact publication failed: ${error instanceof Error ? error.message : String(error)}`,
					"Crew Intake",
					"invalid-payload",
				),
				format: options.format,
				full: false,
			};
		}
		validateContent(content, "stdin");
	}
	if (content === undefined) throw new UsageError("Missing feedback source; use --message <text> or --stdin");
	try {
		const publication = await deps.submit({ projectRoot: context.cwd, content });
		return {
			kind: "result",
			result: {
				ok: true,
				target: publication.contact.name,
				status: "published",
				response: contactResponse(publication),
				data: publication,
			},
			format: options.format,
			full: false,
		};
	} catch (error) {
		if (error instanceof UsageError) throw error;
		const code = error instanceof ContactError ? error.code : "storage-unavailable";
		const message = error instanceof Error ? error.message : "Contact publication failed";
		return {
			kind: "result",
			result: errorResult(message, "Crew Intake", code),
			format: options.format,
			full: false,
		};
	}
}
