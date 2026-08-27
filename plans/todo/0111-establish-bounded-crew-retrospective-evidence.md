---
id: TASK-0111
title: Establish bounded Crew retrospective evidence
status: todo
depends_on: [TASK-0103]
priority: high
tags: [crew-agreements, retrospective, evidence, domain, persistence, tdd]
---

# Establish bounded Crew retrospective evidence

## Problem
Automatic collectors need one deterministic evidence contract; otherwise Crew work becomes incompatible dumps, interpretations masquerade as facts, and retrospective records cannot be reproduced or challenged.

## Context
Crew transparency is the default: visible work performed as a Member is available to the Crew. Security redaction, evidence honesty, deterministic bounds, and token cost remain mandatory.

## Acceptance criteria
- [ ] Pure domain contract defines immutable Retrospective evidence with stable ID, exact `[start,end)` interval, source kind, source identity/reference, bounded visible content or summary, redaction markers, and capture provenance.
- [ ] Supported source kinds cover Bebop coordination, repository artifacts, Member retrospective reports, and optional explicit Member observations without treating any source as activation authority.
- [ ] Evidence and interpretation are structurally separate; evidence cannot contain or imply Agreement activation and a referenced artifact is never claimed as verified merely because it exists.
- [ ] Canonical fingerprints deduplicate shared events across collectors and give stable ordering for identical inputs; collisions/conflicting reuse fail explicitly.
- [ ] Storage is project-local, atomic, restart-safe, concurrency-safe, size/count bounded, and fails closed for corruption, path escape, invalid encoding, NUL, partial write, or unsupported version.
- [ ] Secrets/credentials are deterministically redacted with visible markers; ordinary Crew-visible messages, tool results, and artifacts are not hidden under a privacy policy.
- [ ] Hidden model reasoning is never claimed or collected; unsupported/unavailable evidence sources remain explicit rather than silently complete.
- [ ] Happy/unhappy tests cover interval edges, fingerprinting, deduplication, redaction, bounds, corruption, concurrency, versioning, and authority separation.

## Non-goals
Situation synthesis, Agreement proposals/activation, source-specific collectors, anonymous/private evidence, or unbounded transcript storage.

