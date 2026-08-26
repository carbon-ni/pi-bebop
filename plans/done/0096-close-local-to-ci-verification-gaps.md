---
id: TASK-0096
title: Close local-to-CI verification gaps
status: done
depends_on: []
priority: high
tags: [ci, watcher, hooks, guardrails, determinism, regression, tdd]
---

# Close local-to-CI verification gaps

## Problem
The local watcher can report an old green generation after an unwatched tracked input changes, and the repository pre-push gate is optional and currently uninstalled. As a result, a clean GitHub Actions checkout can discover deterministic failures that local feedback did not run.

## Desired outcome
Any relevant tracked repository change can invalidate and rerun the local final gate, while fast feedback remains targeted. Contributors receive an explicit, verifiable setup path for the repository-owned pre-push gate, and local final verification executes the same quality command as CI.

## Acceptance criteria
- [x] A regression test first proves the current final watcher target omits tracked inputs such as `docs/**`, `scripts/**`, `.github/workflows/**`, and `package-fixtures/**`.
- [x] `quality gate @agent-final` reacts to every non-ignored repository input rather than maintaining an incomplete allowlist; `.tmp/**`, `.pi/**`, `node_modules/**`, coverage, and logs remain excluded.
- [x] Quick test, format, lint, and audit jobs remain narrowly targeted and retain existing recovery/concurrency behavior.
- [x] Automated configuration coverage asserts both GitHub CI and the local final watcher invoke the canonical `make all` command, preventing command drift.
- [x] Automated coverage prevents the broad final-gate trigger from regressing to the previous source-only allowlist.
- [x] A controlled tracked documentation change or deletion produces a newer final-gate generation; restoring it produces another newer generation, both with unchanged deterministic results.
- [x] `make hooks-install` installs the repository-owned hooks and an explicit check demonstrates `core.hooksPath=.githooks` and executable pre-push hook calling `make all`.
- [x] Contributor setup documentation tells a fresh clone to install hooks and explains that hooks provide early feedback but GitHub CI remains authoritative.
- [x] No lifecycle script silently mutates a user's Git configuration during `npm install`, package installation, or extension startup.
- [x] The fix does not weaken clean-checkout CI, ignored runtime isolation, test coverage, security audit, or release verification.
- [x] Focused happy/unhappy tests, configuration validation, fresh watcher final gate, and diff checks pass.

## Verification evidence

- Configuration regression test was red against the previous source-only watcher allowlist, then green after broadening the final gate: `node --test scripts/verification-config.test.mjs` (5/5).
- `make hooks-check` failed before setup with actionable guidance, then `make hooks-install && make hooks-check` passed and confirmed `.githooks/pre-push` is executable and runs `make all`.
- Controlled tracked `docs/ARCHITECTURE.md` change produced watcher generation 176 PASS; restoring the file produced later generation 184 PASS (intermediate generations were superseded by the restore event). Full watcher generation 186 PASS ran `npm run format:check && make all`.
- Commit `8153f97` contains the local/CI parity implementation; prior CI fix `517572e` removes the stale Markdown coupling.

## Non-goals
- Making client-side Git hooks a security boundary or assuming they cannot be bypassed.
- Running `npm ci` on every watched file change.
- Broadening every quick watcher job.
- Replacing GitHub Actions, release gates, or branch protection.

## Evidence from incident
CI run `32931226075` failed because commit `538d2a9` deleted `docs/CLI-MEMBERSHIP-PARITY.md` while a test still read it. `.watch.yaml` did not include `docs/**`, so no newer local generation ran; the existing `.githooks/pre-push` would have caught the failure, but `core.hooksPath` was unset.

