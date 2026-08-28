# TASK-0088 send_to_inbox slice

Migrated send_to_inbox failures to shared actionableToolError and updated the bounded error matrix to assert actionableError/code parity, canonical content identity, and serialized-details raw suppression across unjoined, unknown, self, untrusted, and full-inbox cases.

Evidence: focused suite 5/5; watcher gen512 PASS/current; typecheck PASS. Kelly review requested.
