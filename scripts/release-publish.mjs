import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Pure duplicate policy: identical bytes are resumable; mismatches are fatal. */
export function publicationDecision(localSha256, existingSha256) {
	if (!existingSha256) return "publish";
	if (existingSha256 === localSha256) return "identical";
	return "mismatch";
}

async function sha256(file) {
	return createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
}

async function npmArtifact(packageName, version, directory) {
	try {
		const result = await execFile("npm", [
			"pack",
			`${packageName}@${version}`,
			"--ignore-scripts",
			"--json",
			"--pack-destination",
			directory,
		]);
		const entry = JSON.parse(result.stdout)[0];
		return path.join(directory, entry.filename);
	} catch (error) {
		if (/E404|not found/i.test(error.stderr ?? "")) return null;
		throw error;
	}
}

async function existingReleaseAsset(tag, filename, directory) {
	const view = await execFile("gh", ["release", "view", tag, "--json", "assets"]);
	const assets = JSON.parse(view.stdout).assets ?? [];
	if (!assets.some((asset) => asset.name === filename)) return null;
	await execFile("gh", ["release", "download", tag, "--pattern", filename, "--dir", directory]);
	return path.join(directory, filename);
}

export async function publishRelease({ tarball, packageName, version, releaseTag, npmTag }) {
	const localSha256 = await sha256(tarball);
	const work = await mkdtemp(path.join(tmpdir(), "pi-bebop-release-"));
	try {
		const npmExisting = await npmArtifact(packageName, version, work);
		const npmDecision = publicationDecision(localSha256, npmExisting && (await sha256(npmExisting)));
		if (npmDecision === "mismatch")
			throw new Error(`npm ${packageName}@${version} exists with different artifact bytes`);
		if (npmDecision === "publish") {
			await execFile("npm", ["publish", tarball, "--access", "public", "--tag", npmTag]);
		}

		const asset = path.basename(tarball);
		const releaseExisting = await existingReleaseAsset(releaseTag, asset, work);
		const releaseDecision = publicationDecision(localSha256, releaseExisting && (await sha256(releaseExisting)));
		if (releaseDecision === "mismatch") throw new Error(`GitHub Release ${releaseTag} has a different ${asset}`);
		if (releaseDecision === "publish") await execFile("gh", ["release", "upload", releaseTag, tarball]);

		const checksum = path.join(path.dirname(tarball), "SHA256SUMS");
		const checksumExisting = await existingReleaseAsset(releaseTag, "SHA256SUMS", work);
		if (checksumExisting) {
			const [expected, actual] = await Promise.all([
				readFile(checksum, "utf8"),
				readFile(checksumExisting, "utf8"),
			]);
			if (expected !== actual) throw new Error(`GitHub Release ${releaseTag} has a different SHA256SUMS`);
		} else {
			await execFile("gh", ["release", "upload", releaseTag, checksum]);
		}
		return { npm: npmDecision, github: releaseDecision, sha256: localSha256 };
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const tarball = process.argv[2];
	if (!tarball) throw new Error("Usage: node scripts/release-publish.mjs <tarball>");
	const packageJson = JSON.parse(await readFile("package.json", "utf8"));
	const result = await publishRelease({
		tarball,
		packageName: packageJson.name,
		version: packageJson.version,
		releaseTag: process.env.RELEASE_TAG,
		npmTag: process.env.NPM_TAG ?? "latest",
	});
	console.log(JSON.stringify(result));
}
