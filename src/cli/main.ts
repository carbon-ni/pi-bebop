#!/usr/bin/env node
import { parseCliArguments, UsageError, type SendCliOptions } from "./arguments.ts";
import { renderCliResult, type CliResult } from "./output.ts";
import { sendDirectMessage, DirectMessageError } from "../application/direct-message.ts";

export function errorCode(error: unknown): string {
	if (error instanceof DirectMessageError) return error.code;
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
	const systemCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (systemCode === "EACCES" || systemCode === "EPERM") return "permission-denied";
	if (systemCode === "ENOENT") return "offline";
	if (error instanceof Error && /JSON|malformed|parse/i.test(error.message)) return "malformed-response";
	return "offline";
}

function requestedFormat(args: string[]): "toon" | "json" | "text" {
	const index = args.indexOf("--format");
	const value = index >= 0 ? args[index + 1] : undefined;
	return value === "json" || value === "text" ? value : "toon";
}

function usage(error: UsageError, output: NodeJS.WritableStream, format: "toon" | "json" | "text"): number {
	const result: CliResult = { ok: false, target: "", status: "usage", error: { code: "usage", message: error.message } };
	output.write(`${format === "text" ? error.message : renderCliResult(result, format, false)}\n`);
	return 2;
}

export async function runCli(args: string[], cwd = process.cwd(), input = process.stdin, output = process.stdout): Promise<number> {
	let options: SendCliOptions;
	try { options = parseCliArguments(args, cwd); } catch (error) { return usage(error as UsageError, output, requestedFormat(args)); }
	let message = options.message;
	const controller = new AbortController();
	const abortError = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
	const abort = () => controller.abort(abortError);
	process.once("SIGINT", abort);
	try {
		if (options.stdin) {
			message = await new Promise<string>((resolve, reject) => {
				let data = "";
				const onData = (chunk: string) => { data += chunk; };
				const cleanup = () => { input.off("data", onData); input.off("end", onEnd); input.off("error", onError); controller.signal.removeEventListener("abort", onAbort); };
				const onEnd = () => { cleanup(); resolve(data); };
				const onError = (error: Error) => { cleanup(); reject(error); };
				const onAbort = () => { cleanup(); input.pause(); input.destroy(); reject(abortError); };
				input.setEncoding("utf8"); input.on("data", onData); input.once("end", onEnd); input.once("error", onError); controller.signal.addEventListener("abort", onAbort, { once: true });
			});
			if (message.length === 0) return usage(new UsageError("--stdin received empty input; provide UTF-8 message content"), output, options.format);
		}
		const result = await sendDirectMessage({ socketPath: options.socketPath, message: message!, mode: options.mode, wait: options.wait, timeoutMs: options.timeoutMs, signal: controller.signal, requireAssistantResponse: true });
		const outputResult: CliResult = { ok: true, target: options.socketPath, status: result.status, response: result.message?.content, data: result.data, turnIndex: result.turnIndex };
		output.write(`${renderCliResult(outputResult, options.format, options.full)}\n`);
		return 0;
	} catch (error) {
		const messageText = error instanceof Error ? error.message : "Unknown operational failure";
		const outputResult: CliResult = { ok: false, target: options.socketPath, status: "error", error: { code: errorCode(error), message: messageText } };
		output.write(`${renderCliResult(outputResult, options.format, options.full)}\n`);
		return 1;
	} finally {
		process.removeListener("SIGINT", abort);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "CLI failure"}\n`); process.exitCode = 1; });
}
