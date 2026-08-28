# TASK-0088 surrogate safety follow-up

Fixed `hasUnpairedSurrogate()` to reject a lone high surrogate at end-of-string (explicit missing-next check). Added regression coverage for lone high surrogates in operation and valid choices, asserting no `\\ud800` output.

Evidence:
- Focused presenter tests: 5/5 PASS.
- Typecheck and architecture checks: PASS.
- Watcher gen 357: PASS/current (`npm test`, format check, lint, `make all`).

Awaiting Kelly re-review; no adapter migration performed.
