---
id: TASK-0115
title: Assemble the shared Crew Retrospective Record
status: todo
depends_on: [TASK-0112, TASK-0113, TASK-0114]
priority: high
tags: [crew-agreements, retrospective, evidence, synthesis, determinism, tdd]
---

# Assemble the shared Crew Retrospective Record

## Problem
Raw evidence from Bebop, the repository, and Member sessions is too fragmented and large for useful discussion; every Member needs the same bounded record with facts, interpretations, and proposals clearly separated.

## Context
The system deterministically assembles evidence; any model/facilitator synthesis is stored as explicit candidate interpretation and must link back to evidence.

## Acceptance criteria
- [ ] Assembly snapshots one exact interval and collector versions/inputs into an immutable Crew Retrospective Record with stable ID and content hash.
- [ ] Record contains a deterministic evidence index plus bounded Retrospective situations; each situation identifies contributors, evidence IDs, factual summary, separately labelled interpretation, and related Current/Trial Agreement IDs when present.
- [ ] No situation exists without evidence references; conflicting accounts remain side-by-side or explicitly disputed rather than silently merged into consensus.
- [ ] Cross-source duplicates are linked/deduplicated by canonical fingerprint while distinct provenance remains inspectable.
- [ ] Deterministic limits/order handle overflow with explicit omitted counts and retained references; no silent truncation or raw transcript dump.
- [ ] Candidate synthesis bytes and producer are preserved; nondeterministic model output is never presented as deterministic domain inference.
- [ ] Once frozen, late evidence belongs to the next interval; correction/challenge appends review evidence and never rewrites the original record.
- [ ] Every configured Member can receive/inspect the same exact record identity and bytes; missing collector/report states remain visible.
- [ ] Tests cover identical inputs, conflicting sources, duplicate evidence, overflow, redaction, missing collectors, late evidence, content hashing, and authority separation.

## Non-goals
Agreement proposal/activation, automatic consensus, truth adjudication, sentiment/productivity scoring, or unbounded artifact embedding.

