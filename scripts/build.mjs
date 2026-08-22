import { buildSync } from "esbuild";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const root = dirname(dist);
const lock = join(root, ".bebop-build.lock");
mkdirSync(root, { recursive: true });
const lockHeld = process.env.BEBOP_BUILD_LOCK_HELD === "1";
if (!lockHeld)
	while (true) {
		try {
			mkdirSync(lock);
			break;
		} catch {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
const staging = mkdtempSync(join(root, ".bebop-build-"));
try {
	mkdirSync(join(staging, "cli"), { recursive: true });
	buildSync({
		entryPoints: ["src/cli/main.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		outfile: join(staging, "cli/main.js"),
	});
	buildSync({
		entryPoints: ["src/extension.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		external: ["@earendil-works/*", "@sinclair/typebox", "typebox"],
		outfile: join(staging, "extension.js"),
	});
	const backup = join(root, `.previous-dist-${process.pid}`);
	rmSync(backup, { recursive: true, force: true });
	try {
		renameSync(dist, backup);
	} catch {
		// The first build may be creating dist for the first time.
	}
	renameSync(staging, dist);
	rmSync(backup, { recursive: true, force: true });
} finally {
	rmSync(staging, { recursive: true, force: true });
	if (!lockHeld) rmSync(lock, { recursive: true, force: true });
}
