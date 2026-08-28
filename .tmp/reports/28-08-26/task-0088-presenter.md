# TASK-0088 slice 2 — pure Actionable Error presenter

Added `src/domain/actionable-error.ts` and exported it through the domain barrel. The closed descriptor produces bounded deterministic presentation data, canonical text, safe locations/choices, duplicate/overflow choice accounting, and redaction for credentials/private keys/Bearer/AWS patterns. It never accepts arbitrary Error objects.

Evidence: `npx tsx --test src/domain/actionable-error.test.ts` 2/2 PASS; `npm run typecheck` PASS.

Next: adapter mapping and envelope migration in later slices. Current presenter intentionally does not yet replace existing public adapter renderers.
