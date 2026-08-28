# TASK-0088 member-message CLI safety

Closed a remote-error-code injection path: socket/RPC remote failures are normalized to a finite safe code set before entering the CLI Actionable Error presenter. Unknown/path-bearing remote codes become `remote-rejected`, and public error presentation cannot interpolate the raw code/path. Added member-message regression for path-bearing remote error codes across text/JSON/TOON.

Evidence: focused member-message/errors 22/22 PASS; guard PASS (23); typecheck PASS. Watcher was continuously superseded while this edit was active; rerun fresh gate after commit.
