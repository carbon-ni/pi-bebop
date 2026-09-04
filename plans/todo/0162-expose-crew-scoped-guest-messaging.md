---
id: TASK-0162
title: Expose crew-scoped Guest messaging
status: doing
depends_on: [TASK-0161]
priority: high
tags: [crew, guest, messaging, multi-crew, tools, cli, protocol, tdd]
---

# Expose crew-scoped Guest messaging

## Problem

An admitted Guest cannot be a useful participant until it can discover its
joined crews and exchange ordinary messages with the correct crew without
ambiguous targets, privileged Member operations, or accidental cross-crew
delivery.

## Desired outcome

Guest gets a dynamically scoped messaging surface for each approved membership.
Every outbound Guest action requires exact `crew` selector and exact target (or
Crew Broadcast). Existing Member messaging stays concise and implicitly scoped
to Member's one joined crew.

Crew Members can address an approved Guest by unique Guest name through normal
Follow-up and Member Request surfaces. Guest participates in transient Broadcast
recipient set. No messaging operation reveals or accepts Guest capability or
socket route.

## Acceptance criteria

- [ ] TDD covers Member↔Guest Follow-up, Member Request/Response, Broadcast,
      multi-crew same-name targets, offline recipients, revoke race, spoofed
      origin, wrong crew, and unsupported privileged operation paths.
- [ ] Guest messaging surface is registered only with at least one approved
      membership and lists exact permitted capabilities in model context.
- [ ] Every Guest-originated send requires stable `crew` selector even when only
      one crew is joined; no active, first, recent, or unique-name crew fallback.
- [ ] Target resolution occurs only inside selected approved crew. Same Member
      names across crews cannot cause ambiguity or cross-crew delivery.
- [ ] Typed Guest Origin derives from approved runtime identity, never caller
      fields, and renders `from <name> (guest)` with safe crew context.
- [ ] Guest can send/receive ordinary Follow-ups and correlated Member
      Requests/Responses using existing scheduling, timing, correlation, and
      honest acknowledgement semantics.
- [ ] Live Crew Broadcast includes approved Guest in deterministic roster order,
      excludes exact sender whether Member or Guest, and reports every
      delivered/failed disposition without Inbox fallback.
- [ ] Offline Guest/Member failures are explicit; no transient Guest message is
      persisted or retried automatically.
- [ ] Revocation or leave immediately prevents new sends and responses for that
      crew without affecting in-flight evidence or other crews.
- [ ] Guest cannot call or be silently routed through `send_to_inbox`, Redirect,
      Interrupt, Member endpoint ownership, Guest administration, or crew
      control surfaces.
- [ ] Member tools accept unique approved Guest targets where capability allows,
      while collisions return actionable qualification errors and never guess.
- [ ] CLI exposes equivalent explicitly crew-scoped Guest messaging with
      text/TOON/JSON parity and self-correcting errors.
- [ ] Roster, model context, and help clearly distinguish Member, Guest, pending
      request, offline approval, and external Intake actor.
- [ ] Real multi-runtime test joins one Guest to two crews, exchanges independent
      request/follow-up/broadcast flows, revokes one membership, and proves the
      other remains usable with no route/identity leakage.
- [ ] Existing Member-only messaging and Intake happy/unhappy paths remain
      regression-covered; package, architecture, coverage, watcher, and
      independent exact-head QA gates pass.

## Constraints

- Reuse Member messaging transport/correlation seams with explicit participant
  authorization rather than duplicating socket delivery logic.
- Capability validation occurs before target resolution or payload delivery.
- Guest credentials, raw crew paths, and callback sockets never enter model
  content or ordinary structured output.

## Non-goals

- Guest Inbox, Redirect/Interrupt, automatic responses, cross-crew Broadcast,
  Guest-to-Guest private messaging outside shared crew, response aggregation,
  remote networking, or a default active crew.

## Blocked on dependency defect (2026-09-04)

Mandatory dependency check against TASK-0161 failed. Crew-owned Guest approval
state usable by every Member runtime does not exist:

- Admission persistence is session-private (`pi.appendEntry` of
  `intray-guest-memberships` in the approving Member's session; restore reads
  only that session's branch — `src/extension.ts`, `src/pi/membership-context.ts`).
- `.pi/bebop/` holds only the manifest (approvers config, no guest registry).
- Consequence: other crew Members' runtimes hold empty admission registries, so
  direct Guest->Member validation, Member->Guest addressing by name, crew-wide
  `/crew guests` state, and revocation visibility are all impossible today.

Protocol slice implementation is stopped. Domain foundation commit `fc5f51f`
is preserved (routing-agnostic selectors remain valid under direct routing).
PO decision 2026-09-04: TASK-0161 reopened to deliver the crew-owned Guest
registry (see 0161 plan). TASK-0162 stays stopped until that lands; messaging
slices resume only after 0161 recloses with independent QA.
