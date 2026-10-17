# Resume a session by role

Use the picker to reopen **one** earlier Pi session attributed to a role in the current trusted crew:

```bash
bebop session resume --role developer
```

Select a session and Bebop launches that exact Pi history in its original working directory. It does not start a new session, copy a conversation, or resume the whole crew. Plain `pi -r` is unchanged and does not filter by crew role.

## Which sessions appear?

A prior session must contain a membership record for the exact current crew, member, role, and manifest fingerprint. Sessions without that record, or whose record no longer matches the manifest, are excluded. Bebop does not infer membership from names, timestamps, prompts, or session files.

Cancel the picker, or find no matching sessions, and nothing launches. Bebop also refuses stale, malformed, or untrusted sessions and avoids launching a second writer when the exact member is already online. Validation is an observation, not a lock; a different process could still open the same file afterwards.

This picker differs from a [Crew Session bookmark](CREW-SESSION.md): bookmarks capture several members at a chosen moment and return manual startup instructions for each. The role picker discovers one previously attributed session and launches it after selection.
