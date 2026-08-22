import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireBuildLock } from "./build-lock.mjs";
import { atomicSwapDirectory } from "./build-swap.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);
const dist = join(projectRoot, "dist");
const lockPath = join(projectRoot, ".bebop-build.lock");
const release = await acquireBuildLock(lockPath);
let staging;

try {
	staging = await mkdtemp(join(projectRoot, ".bebop-build-"));
	await mkdir(join(staging, "cli"), { recursive: true });
	await build({
		entryPoints: [join(projectRoot, "src/cli/main.ts")],
		bundle: true,
		platform: "node",
		format: "esm",
		outfile: join(staging, "cli/main.js"),
	});
	await build({
		entryPoints: [join(projectRoot, "src/extension.ts")],
		bundle: true,
		platform: "node",
		format: "esm",
		external: ["@earendil-works/*", "@sinclair/typebox", "typebox"],
		outfile: join(staging, "extension.js"),
	});
	await atomicSwapDirectory(staging, dist, `${dist}.backup-${process.pid}`);
	staging = undefined;
} finally {
	// atomicSwapDirectory owns staging/backup cleanup; this removes staging if compilation failed.
	if (staging) await rm(staging, { recursive: true, force: true });
	await release();
}
