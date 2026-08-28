# TASK-0088 tool slice — member intent tools

Added shared `actionableToolError` envelope and migrated member intent tool failures to it. Tool errors now retain `isError: true`, compatibility `details.error`, full `details.actionableError`, and canonical message content. Error reasons are closed code-specific text; raw exception messages are not rendered.

Also narrowed the direct-render guard to recognize the shared tool presenter helper as an owned presentation boundary.

Evidence:
- Member-tool focused suite: 11/11 PASS.
- Watcher gen484 `@agent-final`: PASS/current.
- Typecheck and guard pass.

Remaining: migrate other registered tools and Pi/startup/lifecycle adapters; task remains open.
