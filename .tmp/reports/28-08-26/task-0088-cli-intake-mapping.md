# TASK-0088 explicit send--crew mapping

Made the `send --crew` known ExternalIntakeError mapping explicit in the public handler: read-failed and invalid-json use closed factual reasons, while the shared target/location sanitizer omits unsafe paths and the stable source code remains intact. No raw ExternalIntakeError message is passed to presentation.

Evidence:
- send-handler focused suite: 11/11 PASS
- Guard: PASS (23 entries)
- Watcher gen424 `@agent-final`: PASS/current
- Typecheck: PASS

Await Kelly review against this commit; tools/Pi adapters remain pending.
