#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseCliCommand, UsageError, type CliCommand, type SendCliOptions } from "./arguments.ts";
import { sendHelp } from "./commands/send.ts";
import { renderCliResult, type CliResult } from "./output.ts";
import { crewInitHelp } from "../domain/index.ts";
import { createCrewInitFlow } from "../application/crew-init-flow.ts";
import { createNodeCrewInitFsAdapter } from "../infra/crew-init-fs.ts";
import { sendDirectMessage, DirectMessageError } from "../application/direct-message.ts";
import { submitExternalIntake, ExternalIntakeError } from "../application/external-intake.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import { CrewManifestReadError } from "../infra/crew-manifest-store.ts";
import { isTrustedCrewManifestPath } from "../infra/crew-layout.ts";
import { parseCrewManifest, type CrewManifest } from "../domain/index.ts";

export function errorCode(error: unknown): string {
	if (error instanceof ExternalIntakeError) return error.code;
	if (error instanceof DirectMessageError) return error.code;
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "EACCES" || systemCode === "EPERM") return "permission-denied";
	if (systemCode === "ENOENT") return "offline";
	if (error instanceof Error && /JSON|malformed|parse/i.test(error.message)) return "malformed-response";
	return "offline";
}

function homeExecutable(): string {
	const argv1 = process.argv[1];
	if (!argv1) return "pi-bebop";
	return argv1.replace(process.env.HOME ?? "~", "~");
}

function redactHome(value: string): string {
	const home = process.env.HOME;
	if (!home) return value;
	return value.replace(home, "~");
}

function requestedFormat(args: string[]): "toon" | "json" | "text" {
	// Usage errors must honor an explicitly requested output format even when
	// parsing fails (TASK-0056 contract edge: both --format json and
	// --format=json forms). Last occurrence wins, consistent with the parser.
	let format: "toon" | "json" | "text" = "toon";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--format") {
			const value = args[index + 1];
			if (value === "json" || value === "text") format = value;
		} else if (arg.startsWith("--format=")) {
			const value = arg.slice("--format=".length);
			if (value === "json" || value === "text") format = value;
		}
	}
	return format;
}

function usage(error: UsageError, output: NodeJS.WritableStream, format: "toon" | "json" | "text"): number {
	const result: CliResult = {
		ok: false,
		target: "",
		status: "usage",
		error: { code: "usage", message: error.message },
	};
	output.write(`${format === "text" ? error.message : renderCliResult(result, format, false)}\n`);
	return 2;
}

/**
 * CLI manifest loader with caller-consent framing (TASK-0040 trust boundary):
 * the explicit --crew path plus readable exact-layout manifest plus filesystem
 * permissions are the consent. We enforce layout/filesystem safety here and
 * never report the project as Pi-trusted; the trusted store re-validates the
 * exact layout on open.
 */
function createCrewManifestLoader(cwd: string): (manifestPath: string) => Promise<CrewManifest> {
	return async (manifestPath) => {
		const resolved = path.resolve(cwd, manifestPath);
		const projectRoot = path.resolve(path.dirname(resolved), "..", "..");
		if (!isTrustedCrewManifestPath(resolved, projectRoot)) {
			throw new CrewManifestReadError(
				"untrusted-path",
				`crew manifest must be in an exact supported layout (.pi/bebop or .pi/crew): ${manifestPath}`,
			);
		}
		let contents: string;
		try {
			contents = await fs.readFile(resolved, "utf8");
		} catch (error) {
			throw new CrewManifestReadError("read-failed", `failed to read crew manifest: ${resolved}`, {
				cause: error,
			});
		}
		let input: unknown;
		try {
			input = JSON.parse(contents);
		} catch (error) {
			throw new CrewManifestReadError("invalid-json", `invalid JSON in crew manifest: ${resolved}`, {
				cause: error,
			});
		}
		return parseCrewManifest(input, resolved);
	};
}

async function runExternalIntake(options: SendCliOptions, message: string, cwd: string): Promise<CliResult> {
	try {
		const ack = await submitExternalIntake(
			{
				manifestPath: options.crewPath!,
				label: options.origin?.label ?? "external",
				content: message,
				instructions: options.instructions.length === 0 ? undefined : options.instructions,
			},
			{
				loadManifest: createCrewManifestLoader(cwd),
				// Caller consent replaces Pi trust for the standalone CLI: the explicit
				// --crew path (already layout-validated) plus filesystem permissions are
				// the consent; the store re-validates the exact layout. We never report
				// the project as Pi-trusted.
				openStore: async (storeOptions) =>
					openTrustedMemberInboxStore({
						manifestPath: storeOptions.manifestPath,
						projectRoot: storeOptions.projectRoot,
						isProjectTrusted: () => true,
						member: storeOptions.member,
					}),
			},
		);
		return {
			ok: true,
			target: options.crewPath!,
			status: "persisted",
			response: `Persisted for ${ack.contact} (${ack.contactRole}) — inbox item ${ack.itemId}`,
			data: ack,
		};
	} catch (error) {
		const messageText = error instanceof Error ? error.message : "Unknown operational failure";
		return {
			ok: false,
			target: options.crewPath!,
			status: "error",
			error: { code: errorCode(error), message: messageText },
		};
	}
}

export async function runCli(
	args: string[],
	cwd = process.cwd(),
	input = process.stdin,
	output = process.stdout,
): Promise<number> {
	let options: CliCommand;
	try {
		options = parseCliCommand(args, cwd);
	} catch (error) {
		return usage(error as UsageError, output, requestedFormat(args));
	}
	if (options.command === "home") {
		const project = cwd;
		const scaffoldAbs = path.join(project, ".pi/bebop/crew.json");
		let scaffold: "missing" | "present" = "missing";
		try {
			await fs.stat(scaffoldAbs);
			scaffold = "present";
		} catch {
			scaffold = "missing";
		}
		const home: CliResult = {
			ok: true,
			target: "",
			status: "home",
			data: {
				executable: homeExecutable(),
				purpose: "Pi Bebop crew coordination CLI",
				project: redactHome(project),
				scaffold,
				commands: ["send", "crew init"],
				...(scaffold === "missing"
					? { next: "pi-bebop crew init" }
					: { next: 'pi --crew-socket "$PWD/.pi/bebop/sockets/lead.sock"' }),
			},
		};
		output.write(`${renderCliResult(home, "toon", false)}\n`);
		return 0;
	}
	if (options.command === "crew-init") {
		if (options.help) {
			output.write(crewInitHelp());
			return 0;
		}
		const project = options.project ?? cwd;
		try {
			const result = await createCrewInitFlow(createNodeCrewInitFsAdapter()).run(project);
			if (result.ok === false) {
				const outputResult: CliResult = {
					ok: false,
					target: project,
					status: "error",
					error: { code: result.error.code, message: result.error.message },
				};
				output.write(`${renderCliResult(outputResult, options.format, false)}\n`);
				return 1;
			}
			const outputResult: CliResult = {
				ok: true,
				target: project,
				status: result.status,
				response:
					result.status === "created"
						? "Scaffolded .pi/bebop crew; review names/contact/instructions before joining"
						: "Crew scaffold already present and byte-identical",
				data: {
					status: result.status,
					project: result.project,
					manifestPath: result.manifestPath,
					createdPaths: result.createdPaths,
					verifiedPaths: result.verifiedPaths,
					nextCommands: result.nextCommands,
				},
			};
			output.write(`${renderCliResult(outputResult, options.format, false)}\n`);
			return 0;
		} catch (error) {
			const messageText = error instanceof Error ? error.message : "Crew init failed";
			const outputResult: CliResult = {
				ok: false,
				target: project,
				status: "error",
				error: { code: "operational", message: messageText },
			};
			output.write(`${renderCliResult(outputResult, options.format, false)}\n`);
			return 1;
		}
	}
	const sendOptions = options as SendCliOptions;
	if (sendOptions.help) {
		output.write(sendHelp());
		return 0;
	}
	let message = sendOptions.message;
	const controller = new AbortController();
	const abortError = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
	const abort = () => controller.abort(abortError);
	process.once("SIGINT", abort);
	try {
		if (options.stdin) {
			message = await new Promise<string>((resolve, reject) => {
				let data = "";
				const onData = (chunk: string) => {
					data += chunk;
				};
				const cleanup = () => {
					input.off("data", onData);
					input.off("end", onEnd);
					input.off("error", onError);
					controller.signal.removeEventListener("abort", onAbort);
				};
				const onEnd = () => {
					cleanup();
					resolve(data);
				};
				const onError = (error: Error) => {
					cleanup();
					reject(error);
				};
				const onAbort = () => {
					cleanup();
					input.pause();
					input.destroy();
					reject(abortError);
				};
				input.setEncoding("utf8");
				input.on("data", onData);
				input.once("end", onEnd);
				input.once("error", onError);
				controller.signal.addEventListener("abort", onAbort, { once: true });
			});
			if (message.length === 0)
				return usage(
					new UsageError("--stdin received empty input; provide UTF-8 message content"),
					output,
					options.format,
				);
		}
		if (options.crewPath !== undefined) {
			const intakeResult = await runExternalIntake(options, message!, cwd);
			output.write(`${renderCliResult(intakeResult, options.format, options.full)}\n`);
			return intakeResult.ok ? 0 : 1;
		}
		const result = await sendDirectMessage({
			socketPath: options.socketPath!,
			message: message!,
			...(options.instructions.length === 0 ? {} : { instructions: options.instructions }),
			...(options.origin === undefined ? {} : { origin: options.origin }),
			mode: options.mode,
			wait: options.wait,
			timeoutMs: options.timeoutMs,
			signal: controller.signal,
			requireAssistantResponse: true,
		});
		const outputResult: CliResult = {
			ok: true,
			target: options.socketPath!,
			status: result.status,
			response: result.message?.content,
			data: result.data,
			turnIndex: result.turnIndex,
		};
		output.write(`${renderCliResult(outputResult, options.format, options.full)}\n`);
		return 0;
	} catch (error) {
		const messageText = error instanceof Error ? error.message : "Unknown operational failure";
		const outputResult: CliResult = {
			ok: false,
			target: options.crewPath ?? options.socketPath ?? "",
			status: "error",
			error: { code: errorCode(error), message: messageText },
		};
		output.write(`${renderCliResult(outputResult, options.format, options.full)}\n`);
		return 1;
	} finally {
		process.removeListener("SIGINT", abort);
	}
}

if (
	process.argv[1]?.replaceAll("\\\\", "/").endsWith("/dist/cli/main.js") &&
	import.meta.url.endsWith("/dist/cli/main.js")
) {
	runCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(`${error instanceof Error ? error.message : "CLI failure"}\n`);
			process.exitCode = 1;
		});
}
