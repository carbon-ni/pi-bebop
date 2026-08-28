# TASK-0088 member-intent details QA

Added serialized `details` assertions to the existing typed/raw failure matrix for both member intent tools. Raw path/message fixtures are now checked against both content and `JSON.stringify(result.details)`.

Evidence: member-tool suite 12/12; watcher gen495 `@agent-final` PASS/current. Implementation unchanged.
