---
id: TASK-0040
title: Define external crew intake feature
status: todo
depends_on: [TASK-0034]
priority: high
tags: [crew, external, intake, manifest, ubiquitous-language]
---

# Define external crew intake feature

## Problem
External Pi sessions, scripts, and local automation can address a live member socket, but they cannot leave one durable message for the crew without knowing who owns intake; silently broadcasting or assuming a lead role would create ambiguous ownership.

## Context

Define **Crew Intake** as public feature for one-way messages crossing from external actor into crew boundary. Define one **crew contact**: configured member responsible for receiving and triaging those messages. In example software crew this should be product owner, because product owns external problem intake and clarification; product may forward actionable work to lead. Do not hardcode `po` or `lead`: manifest selects exact member by unique name.

Proposed optional manifest shape:

```json
{
  "intake": { "contact": "Mary" }
}
```

Crew Intake owns external-facing contract, contact selection, acknowledgement semantics, and handoff into Inbox. Inbox owns persistence/delivery only. External crew message is durable inbox item addressed to contact. It is not broadcast, shared mailbox, authentication, task creation, or automatic dispatch. Missing contact means external crew intake is disabled; never fall back to first/online member.

## Acceptance criteria

- [ ] `UL.md` defines Crew Intake, external actor, crew contact, and external crew message in one sentence each.
- [ ] Crew Intake is documented as feature; Inbox is its durable delivery dependency rather than same concept.
- [ ] External actor means local process or Pi session that is not joined as current crew member.
- [ ] Manifest can optionally select exactly one configured member name as crew contact; unknown/ambiguous/extra fields are rejected.
- [ ] No contact produces explicit `external-intake-disabled`; no implicit lead/PO/first-online fallback exists.
- [ ] Message is persisted to contact inbox and may arrive while contact offline.
- [ ] External origin/label is claimed and unverified; contact identity and inbox location come only from validated manifest.
- [ ] Trust boundary is explicit: Pi surfaces require project trust; standalone CLI treats explicitly supplied exact-layout manifest plus filesystem permissions as caller consent and never claims Pi trust.
- [ ] Intake is one-way for MVP: persistence acknowledgement contains no reply route or promised response.
- [ ] Product-owner contact is documented recommendation for software crew, while other crew shapes may configure any member.
- [ ] Contact responsibility is limited to triage: ignore malformed/unwanted content, clarify through external channel when available, or forward internally using follow-up/inbox; redirect remains exceptional.
- [ ] Bebop does not classify content, select internal worker, or infer that intake became accepted software work.
- [ ] Domain/manifest tests cover enabled, disabled, renamed/missing contact, strict schema, and role-name non-authority.

## Out of scope

- Broadcast/shared inbox, topic routing, load balancing, fallback contact, automatic task creation, remote network exposure, authentication, or request-response correlation.

