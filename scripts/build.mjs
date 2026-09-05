import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireBuildLock } from "./build-lock.mjs";
import { atomicSwapDirectory } from "./build-swap.mjs";
import { resolveBuildCommit } from "./build-metadata.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);
const dist = join(projectRoot, "dist");
const lockPath = join(projectRoot, ".bebop-build.lock");
const release = await acquireBuildLock(lockPath);
let staging;

function readGitCommit() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
	} catch {
		return undefined;
	}
}

try {
	const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
	const buildCommit = resolveBuildCommit({
		gitCommit: readGitCommit(),
		override: process.env.PI_BEBOP_BUILD_COMMIT,
	});
	staging = await mkdtemp(join(projectRoot, ".bebop-build-"));
	await mkdir(join(staging, "cli"), { recursive: true });
	await build({
		entryPoints: [join(projectRoot, "src/cli/main.ts")],
		bundle: true,
		platform: "node",
		format: "esm",
		outfile: join(staging, "cli/main.js"),
		define: {
			__PI_BEBOP_PACKAGE_VERSION__: JSON.stringify(packageJson.version),
			__PI_BEBOP_BUILD_COMMIT__: JSON.stringify(buildCommit),
		},
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
