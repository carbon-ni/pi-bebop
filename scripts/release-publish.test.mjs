import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	publishRelease,
	publicationDecision,
	qualityGateAllowsPublish,
	releaseNpmTag,
	releaseTagMatchesVersion,
} from "./release-publish.mjs";

const fixture = async (bytes = "release-bytes") => {
	const root = await mkdtemp(path.join(tmpdir(), "release-publish-test-"));
	const tarball = path.join(root, "carbon-ni-pi-bebop-0.1.0.tgz");
	await writeFile(tarball, bytes);
	await writeFile(path.join(root, "SHA256SUMS"), `${bytes.length.toString(16)}  ${path.basename(tarball)}\n`);
	return { root, tarball };
};

const npmMissing = () => {
	const error = new Error("missing");
	error.stderr = "npm ERR! code E404";
	return error;
};

test("missing publication uploads npm, GitHub artifact, and checksum", async () => {
	const { root, tarball } = await fixture();
	const calls = [];
	try {
		const run = async (command, args) => {
			calls.push([command, args]);
			if (command === "npm" && args[0] === "pack") throw npmMissing();
			if (command === "gh" && args[0] === "release" && args[1] === "view")
				return { stdout: JSON.stringify({ assets: [] }) };
			return { stdout: "" };
		};
		await publishRelease({
			tarball,
			packageName: "@carbon-ni/pi-bebop",
			version: "0.1.0",
			releaseTag: "v0.1.0",
			npmTag: "latest",
			run,
		});
		assert.ok(calls.some(([, args]) => args[0] === "publish"));
		assert.equal(calls.filter(([, args]) => args[1] === "upload").length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("identical npm and GitHub artifacts skip publication but verify checksum", async () => {
	const { root, tarball } = await fixture();
	const calls = [];
	try {
		const run = async (command, args) => {
			calls.push([command, args]);
			if (command === "npm" && args[0] === "pack") {
				const destination = args.at(-1);
				await copyFile(tarball, path.join(destination, path.basename(tarball)));
				return { stdout: JSON.stringify([{ filename: path.basename(tarball) }]) };
			}
			if (command === "gh" && args[1] === "view")
				return {
					stdout: JSON.stringify({ assets: [{ name: path.basename(tarball) }, { name: "SHA256SUMS" }] }),
				};
			if (command === "gh" && args[1] === "download") {
				const destination = args[args.indexOf("--dir") + 1];
				const name = args[args.indexOf("--pattern") + 1];
				await copyFile(path.join(root, name), path.join(destination, name));
			}
			return { stdout: "" };
		};
		const result = await publishRelease({
			tarball,
			packageName: "@carbon-ni/pi-bebop",
			version: "0.1.0",
			releaseTag: "v0.1.0",
			npmTag: "latest",
			run,
		});
		assert.equal(result.npm, "identical");
		assert.equal(result.github, "identical");
		assert.equal(calls.filter(([, args]) => args[0] === "publish" || args[1] === "upload").length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("npm mismatch fails before any publish", async () => {
	const { root, tarball } = await fixture("different-bytes");
	try {
		const run = async (command, args) => {
			if (command === "npm" && args[0] === "pack") {
				const destination = args.at(-1);
				await writeFile(path.join(destination, path.basename(tarball)), "registry-bytes");
				return { stdout: JSON.stringify([{ filename: path.basename(tarball) }]) };
			}
			return { stdout: JSON.stringify({ assets: [] }) };
		};
		await assert.rejects(
			publishRelease({
				tarball,
				packageName: "@carbon-ni/pi-bebop",
				version: "0.1.0",
				releaseTag: "v0.1.0",
				npmTag: "latest",
				run,
			}),
			/different artifact bytes/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("GitHub artifact mismatch fails closed", async () => {
	const { root, tarball } = await fixture("local-bytes");
	try {
		const run = async (command, args) => {
			if (command === "npm" && args[0] === "pack") throw npmMissing();
			if (command === "gh" && args[1] === "view")
				return { stdout: JSON.stringify({ assets: [{ name: path.basename(tarball) }] }) };
			if (command === "gh" && args[1] === "download") {
				const destination = args[args.indexOf("--dir") + 1];
				await writeFile(path.join(destination, path.basename(tarball)), "remote-bytes");
			}
			return { stdout: "" };
		};
		await assert.rejects(
			publishRelease({
				tarball,
				packageName: "@carbon-ni/pi-bebop",
				version: "0.1.0",
				releaseTag: "v0.1.0",
				npmTag: "latest",
				run,
			}),
			/GitHub Release .*different/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("GitHub checksum mismatch fails closed", async () => {
	const { root, tarball } = await fixture();
	try {
		const run = async (command, args) => {
			if (command === "npm" && args[0] === "pack") throw npmMissing();
			if (command === "gh" && args[1] === "view")
				return { stdout: JSON.stringify({ assets: [{ name: "SHA256SUMS" }] }) };
			if (command === "gh" && args[1] === "download") {
				const destination = args[args.indexOf("--dir") + 1];
				await writeFile(path.join(destination, "SHA256SUMS"), "wrong-checksum\n");
			}
			return { stdout: "" };
		};
		await assert.rejects(
			publishRelease({
				tarball,
				packageName: "@carbon-ni/pi-bebop",
				version: "0.1.0",
				releaseTag: "v0.1.0",
				npmTag: "latest",
				run,
			}),
			/different SHA256SUMS/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("npm-first partial publication skips npm and uploads missing GitHub destinations", async () => {
	const { root, tarball } = await fixture();
	const calls = [];
	try {
		const run = async (command, args) => {
			calls.push([command, args]);
			if (command === "npm" && args[0] === "pack") {
				const destination = args.at(-1);
				await copyFile(tarball, path.join(destination, path.basename(tarball)));
				return { stdout: JSON.stringify([{ filename: path.basename(tarball) }]) };
			}
			if (command === "gh" && args[1] === "view") return { stdout: JSON.stringify({ assets: [] }) };
			return { stdout: "" };
		};
		const result = await publishRelease({
			tarball,
			packageName: "@carbon-ni/pi-bebop",
			version: "0.1.0",
			releaseTag: "v0.1.0",
			npmTag: "latest",
			run,
		});
		assert.equal(result.npm, "identical");
		assert.equal(calls.filter(([, args]) => args[0] === "publish").length, 0);
		assert.equal(calls.filter(([, args]) => args[1] === "upload").length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stable and prerelease channels are deterministic", () => {
	assert.equal(releaseNpmTag(false), "latest");
	assert.equal(releaseNpmTag(true), "next");
});

test("release tag must identify the package version", async () => {
	assert.equal(releaseTagMatchesVersion("v0.1.0", "0.1.0"), true);
	assert.equal(releaseTagMatchesVersion("v0.1.1", "0.1.0"), false);
	const { root, tarball } = await fixture();
	try {
		await assert.rejects(
			publishRelease({
				tarball,
				packageName: "@carbon-ni/pi-bebop",
				version: "0.1.0",
				releaseTag: "v0.1.1",
				npmTag: "latest",
				run: async () => ({ stdout: "" }),
			}),
			/does not match package version/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failed quality gate cannot authorize publication", async () => {
	assert.equal(qualityGateAllowsPublish("success"), true);
	assert.equal(qualityGateAllowsPublish("failure"), false);
	assert.equal(qualityGateAllowsPublish("cancelled"), false);
	const { root, tarball } = await fixture();
	const previous = process.env.QUALITY_GATE_RESULT;
	process.env.QUALITY_GATE_RESULT = "failure";
	try {
		await assert.rejects(
			publishRelease({
				tarball,
				packageName: "@carbon-ni/pi-bebop",
				version: "0.1.0",
				releaseTag: "v0.1.0",
				npmTag: "latest",
				run: async () => ({ stdout: "" }),
			}),
			/Quality gate did not authorize/,
		);
	} finally {
		if (previous === undefined) delete process.env.QUALITY_GATE_RESULT;
		else process.env.QUALITY_GATE_RESULT = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("publication decision remains fail-closed", () => {
	assert.equal(publicationDecision("abc", null), "publish");
	assert.equal(publicationDecision("abc", "abc"), "identical");
	assert.equal(publicationDecision("abc", "def"), "mismatch");
});
