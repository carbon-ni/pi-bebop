# TASK-0093 Bootstrap Artifact

- Release commit: `e97246c5834de94febdef8695eeb89ff04da10f5` (matches `origin/main`)
- Artifact: `/Users/cristianoliveira/other/ai/pi/agent/extensions/pi-bebop/.release/carbon-ni-pi-bebop-0.1.0.tgz`
- SHA-256: `21191f1f58056f0170d1bc17befad075c7c84671309d40a536514781e8d55e11`
- Checksum file: `/Users/cristianoliveira/other/ai/pi/agent/extensions/pi-bebop/.release/SHA256SUMS`
- Runtime used: Node `v22.14.0`, npm `11.5.1`

## Evidence

- `npm pack --pack-destination .release` produced `@carbon-ni/pi-bebop@0.1.0`.
- `PACKAGE_TARBALL=.release/carbon-ni-pi-bebop-0.1.0.tgz npm run verify:package` passed in an isolated consumer and Pi host loader.
- No tag, publish, GitHub Release, npm configuration, or other remote state was changed.
- Artifact was recovered by rebuilding commit `e97246c` with Node `v22.14.0` and npm `11.5.1`; `.release/SHA256SUMS` now verifies the recorded SHA-256.
