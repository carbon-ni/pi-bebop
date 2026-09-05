---
id: TASK-0164
title: Include build commit in CLI version output
status: doing
depends_on: []
priority: normal
tags: []
---

# Include build commit in CLI version output

## Problem

`pi-bebop -v` currently fails as an invalid command, so an installed CLI artifact does not reveal which source revision produced it. Operators need package version and immutable build commit together for reproducible diagnostics.

## Desired outcome

Both root version flags print one concise line:

```text
pi-bebop <package-version> (commit <full-commit-sha>)
```

## Acceptance criteria

- [ ] `pi-bebop -v` and `pi-bebop --version` print identical output and exit 0.
- [ ] Output package version matches `package.json`; commit is the full source commit embedded when the distributable is built.
- [ ] Version handling performs no project, session, socket, or runtime filesystem lookup.
- [ ] Packed-installed CLI preserves the same version and commit as its built artifact.
- [ ] Missing Git metadata fails explicitly at build time unless an explicit validated commit override is supplied.
- [ ] Happy and unhappy build paths have deterministic tests; existing help and command behavior remains unchanged.

## Non-goals

- Changing package SemVer or deriving it from Git tags.
- Reporting dirty-worktree state or querying Git when the CLI runs.

## Constraints

The commit identifies the built source, not the current checkout at runtime. Release archives may execute without a `.git` directory.

## Notes

