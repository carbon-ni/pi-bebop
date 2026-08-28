# TASK-0088 presenter parity remediation

## Changes
- Centralized Actionable Error message construction and refreshes it after every canonical overflow mutation.
- If a location value is removed to fit accounting, `message` is rebuilt without that value.
- Structured location values and choices remain omission-only when detector normalization changes them; omitted properties are not emitted as `undefined`.
- Added unpaired-surrogate handling and exported UTF-8 accounting helper.
- Added adversarial tests for UTF-8 limits, emoji code-point truncation, repeated controls, structured redaction omission, and canonical 4096-byte bounds/message parity.

## Verification
- Focused presenter suite: 5/5 PASS.
- Watcher gen 353: PASS/current (`npm test`, format check, lint, `make all`).
- Typecheck and architecture checks: PASS.

Acceptance still requires Kelly QA re-review; no adapter migration was performed.
