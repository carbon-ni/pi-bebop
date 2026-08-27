---
id: TASK-0109
title: Distribute initial Crew Agreements with crew templates
status: todo
depends_on: [TASK-0102, TASK-0104]
priority: normal
tags: [crew-agreements, crew-init, templates, provenance, tdd]
---

# Distribute initial Crew Agreements with crew templates

## Problem
Shared Crew templates cannot yet carry initial collaboration agreements, forcing adopters to reconstruct the intended way of working and weakening the value of externally shared Crew configurations.

## Context
Extends accepted TASK-0102 external templates; adoption gives a new Crew an initial agreement snapshot, not another Crew's live retrospective state.

## Acceptance criteria
- [ ] Local and Git templates may optionally declare initial Current Crew Agreements using the canonical manifest contract.
- [ ] Template validation checks agreement paths/content before any target write with the same path, symlink, encoding, size, and concurrent-change protections as runtime loading.
- [ ] Adoption copies only the declared initial revision; proposals, retrospective records, Inbox, sockets, and source Crew runtime state are never adopted.
- [ ] Source + resolved commit provenance covers adopted Agreement bytes in TOON/JSON/text output.
- [ ] Template without agreements remains accepted; this task does not independently alter zero-argument built-in scaffold bytes.
- [ ] Exact rerun is unchanged; differing/partial targets retain TASK-0102 conflict and zero-overwrite rules.
- [ ] Packaged examples/documentation show how a shared template supplies initial Crew Agreements that the adopting Crew later evolves locally.
- [ ] Tests cover local/Git sources, absent agreements, invalid paths/content, forbidden history, provenance, rerun, and conflict atomicity.

## Non-goals
Sharing active rounds/proposals, merging Agreement histories, registry/discovery, or automatically pulling upstream Agreement updates.

