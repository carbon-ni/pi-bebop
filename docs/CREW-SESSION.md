# Bookmark member sessions together

A **Crew Session** is a machine-local bookmark for the exact Pi sessions of members online when you capture them. It is not a shared conversation or a command to launch the whole crew.

## Capture before closing members

```bash
bebop session capture "auth regression"
bebop session list
bebop session show <crew-session-id>
```

Capture uses the trusted current-project crew. Pass `--crew <locator>` only when you need to select an explicit trusted crew in that project. The generated ID, not the human-readable name, selects a record; duplicate names are allowed. A capture includes every configured member in manifest order: each has either an exact session link or a reason it was missing. It never guesses a recent session. If none can be linked, `capture-empty` writes nothing.

To fill a missing link while that member is online:

```bash
bebop session add <crew-session-id> <member>
```

`add` requires the exact member name. It never replaces an existing link; capture a new Crew Session instead if a link must change. A capture may be complete or partial. Records are stored outside the project under `$BEBOP_CONTROL_DIR/crew-sessions/` (by default `~/.pi/bebop/crew-sessions/`), not in Git. Bebop restricts local record access to the owner and rejects unsafe paths or symlinks.

## Reopen one member manually

```bash
bebop session resolve <crew-session-id> <member>
```

Resolve checks the saved session, crew and member identity, manifest, working directory, session file, and whether the member appears already open. Review the returned working directory and exact command, then run the command yourself from that directory:

```text
pi --session <absolute-session-file>
```

Resolve does **not** start Pi, add role or model flags, repair history, or lock the session. An `already-open` result refuses a normal resume command to avoid two writers to one conversation file. Endpoint checks can race with another process, so verify the session is still closed before opening it.

`session list` and `session show` inspect stored records without starting Pi or changing them. A missing file, moved worktree, manifest change, or offline process does not silently rebind or delete a link. `show` may disclose session paths: treat them as private local metadata. Ordinary crew status and member tools do not expose these paths, session IDs, or conversation content. For one-role session picking instead, see [resume by role](ROLE-SESSION-RESUME.md).
