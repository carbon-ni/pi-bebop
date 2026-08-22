import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

test("packed consumer can import every structured domain source export", () => {
	const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
	const tarball = JSON.parse(output)[0].filename;
	const temp = mkdtempSync(join("/tmp", "bebop-packed-source-"));
	try {
		execFileSync("tar", ["-xzf", join(root, tarball), "-C", temp]);
		symlinkSync(join(root, "node_modules"), join(temp, "node_modules"), "dir");
		const probe = join(temp, "probe.mjs");
		writeFileSync(
			probe,
			'const domain = await import("./package/src/domain/index.ts"); if (!domain.MessagePayloadSchema || !domain.renderMessagePayload || !domain.isMessagePayload) process.exit(1);',
		);
		execFileSync(process.execPath, ["--import", "tsx", probe], { cwd: root, stdio: "pipe" });
	} finally {
		rmSync(join(root, tarball), { force: true });
		rmSync(temp, { recursive: true, force: true });
	}
});
