# TASK-0094 release upload fix

Fixed the hidden-directory artifact upload failure in commit `3500309`.

- Added a regression contract test for the upload configuration.
- Set `include-hidden-files: true` on `actions/upload-artifact@v4`.
- Restricted uploaded paths to `.release/*.tgz` and `.release/SHA256SUMS`; no broad hidden-file upload.
- TDD unhappy-path test initially failed against the old `.release/` configuration, then passed after the fix.

Verification: workflow contract test and Prettier checks pass. No release, publish, tag, or other remote action was performed.
