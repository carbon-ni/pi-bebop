import { createCrewInitFlow } from "../../application/crew-init-flow.ts";
import { createNodeCrewInitFsAdapter } from "../../infra/crew-init-fs.ts";
import {
	createNodeCrewInitTemplateSourceAdapter,
	resolveNodeTemplateSourceDescriptor,
} from "../../infra/crew-init-template-source.ts";
import { crewInitHelp } from "../../domain/index.ts";
import { actionableErrorResult } from "../errors.ts";
import type { CrewInitCliOptions } from "../arguments.ts";
import type { CliOutcome } from "../output.ts";

/**
 * TASK-0063: `crew init` handler — owns the scaffold flow result mapping and
 * the deterministic local help path. No process streams or signals here; the
 * runner installs cancellation.
 */
export async function runCrewInitCommand(options: CrewInitCliOptions, cwd: string): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: crewInitHelp() };
	const project = options.project ?? cwd;
	try {
		const flow = createCrewInitFlow(createNodeCrewInitFsAdapter(), {
			...(options.from === undefined ? {} : { sourceAdapter: createNodeCrewInitTemplateSourceAdapter() }),
		});
		const source =
			options.from === undefined ? undefined : await resolveNodeTemplateSourceDescriptor(options.from, cwd);
		const sourceWithRef =
			source?.kind === "git" && options.ref !== undefined ? { ...source, ref: options.ref } : source;
		const result = await flow.run(project, sourceWithRef === undefined ? { cwd } : { from: sourceWithRef, cwd });
		if (result.ok === false) {
			return {
				kind: "result",
				result: actionableErrorResult({
					code: result.error.code,
					operation: "pi-bebop crew init",
					reason: "the Crew scaffold could not be prepared",
					recovery: ["verify the project path and permissions, then retry pi-bebop crew init."],
					location: { kind: "project-path", name: "project", value: project },
				}),
				format: options.format,
				full: false,
			};
		}
		return {
			kind: "result",
			result: {
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
					...(result.source === undefined ? {} : { source: result.source }),
				},
			},
			format: options.format,
			full: false,
		};
	} catch {
		return {
			kind: "result",
			result: actionableErrorResult({
				code: "unexpected-failure",
				operation: "pi-bebop crew init",
				reason: "the Crew scaffold could not be prepared",
				recovery: ["verify the project path and permissions, then retry pi-bebop crew init."],
				location: { kind: "project-path", name: "project", value: project },
			}),
			format: options.format,
			full: false,
		};
	}
}
