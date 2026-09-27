import { getTrustedCrewManifestPaths } from "./crew-layout.ts";
import { readDirectoryManifest } from "./crew-directory.ts";
import { sendRpcCommand, RpcProtocolError } from "./rpc-client.ts";
import { currentRuntimeCompatibility } from "../domain/index.ts";
import type { RuntimeDoctorDependencies, RuntimeProbe } from "../application/runtime-doctor.ts";

const PROBE_TIMEOUT_MS = 2_000;

function probeError(error: unknown): RuntimeProbe {
	if (error instanceof RpcProtocolError) {
		if (error.code === "timeout" || /timeout/i.test(error.message)) return { kind: "error", code: "timeout" };
		return { kind: "error", code: error.code };
	}
	if (error instanceof Error && error.name === "AbortError") return { kind: "error", code: "aborted" };
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
	if (code !== undefined) return { kind: "error", code };
	if (error instanceof Error && /timeout/i.test(error.message)) return { kind: "error", code: "timeout" };
	return { kind: "error", code: "transport-error" };
}

export function createRuntimeDoctorDependencies(): RuntimeDoctorDependencies {
	const cli = currentRuntimeCompatibility();
	return {
		discoverManifestPaths: (projectRoot) => getTrustedCrewManifestPaths(projectRoot),
		readManifest: readDirectoryManifest,
		probeRuntime: async (socketPath, options) => {
			try {
				const { response } = await sendRpcCommand(
					socketPath,
					{ type: "runtime_compatibility" },
					{ timeout: Math.min(options.timeoutMs, PROBE_TIMEOUT_MS), signal: options.signal },
				);
				if (!response.success) return { kind: "error", code: "remote-rejected", message: response.error };
				return { kind: "response", value: response.data };
			} catch (error) {
				return probeError(error);
			}
		},
		cli: { packageVersion: cli.packageVersion, buildCommit: cli.buildCommit, protocol: cli.protocol },
	};
}
