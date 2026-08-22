---
id: TASK-0032
title: Support external-root crew socket selection
status: done
depends_on: []
priority: high
tags: [crew, membership, paths, ux, security]
---

# Support external-root crew socket selection

## Problem
A user working in one checkout or worktree must be able to explicitly join a crew whose socket layout lives under another filesystem root. Today this behavior is inconsistent between startup and `/crew join`, lacks cross-root regression coverage, and a small filename mismatch produces a generic member-not-found error with no configured-path guidance.

The observed command selected `.../sockets/dev1`, while the adjacent manifest configures `sockets/dev1.sock`; the error only repeated the unmatched input.

## Context

Treat an explicit absolute socket path as selection of one external crew root, independent of `ctx.cwd`. Preserve the identity boundary: the selected endpoint must still exactly match a member in the adjacent `.pi/bebop/crew.json` or `.pi/crew/crew.json`. “Any path” means either supported crew layout under any filesystem root—not an unconfigured socket or arbitrary manifest location.

Both startup `--crew-socket` and runtime `/crew join` must share this policy. Relative paths continue to resolve from execution cwd. The current project must remain trusted; explicit cross-root selection does not add authentication and Unix socket permissions remain the authorization boundary.

Do not silently append `.sock`: extensionless socket names are valid when explicitly configured. Diagnose likely filename mistakes instead.

## Acceptance criteria

- [ ] From cwd/worktree A, `pi --crew-socket /root-B/.pi/bebop/sockets/dev1.sock` loads only `/root-B/.pi/bebop/crew.json`, resolves the configured member, and claims the endpoint even when the endpoint does not exist before startup.
- [ ] The same external-root behavior is covered for `.pi/crew` compatibility layout and `/crew join <absolute-socket>`; startup and command paths use one selection policy rather than separate trust rules.
- [ ] External-root selection never falls back to cwd manifests, the other layout, or sibling manifests and never merges manifests.
- [ ] `.pi/other`, sockets outside a supported layout, absolute socket entries in a manifest, traversal outside the layout, and members not configured by the selected manifest remain rejected before endpoint claim.
- [ ] Exact configured extensionless endpoints still work; the implementation does not guess or append `.sock`.
- [ ] A no-match error includes the selected path and bounded configured endpoint guidance; for `dev1` versus configured `dev1.sock`, it gives an actionable exact suggestion without claiming an endpoint.
- [ ] Persisted membership selected explicitly from another root restores using that same manifest/socket pair without rebasing paths onto current cwd.
- [ ] README documents cross-worktree startup and runtime examples using the exact configured filename, including `.sock` where configured.
- [ ] Focused domain/store/startup/command/lifecycle tests cover happy and unhappy paths for both layouts, followed by coverage/risk analysis and the final watcher gate.

## Notes

Immediate correction for the reported setup:

```sh
pi --crew-socket "$HOME/other/pi-bebop/.pi/bebop/sockets/dev1.sock" \
  --model openai-second/gpt-5.6-luna
```

The adjacent manifest currently configures Dave as `sockets/dev1.sock`; `sockets/dev1` is a different endpoint identity.

