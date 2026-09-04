---
id: TASK-0160
title: Define multi-crew Guest membership
status: doing
depends_on: []
priority: high
tags: [crew, guest, membership, multi-crew, admission, security, ubiquitous-language]
---

# Define multi-crew Guest membership

## Problem

Crew Intake supports only one-way delivery to a contact, so an external Pi
session cannot hold an ongoing two-way relationship with a crew. Treating that
session as a configured Member would wrongly grant a role and prevents one
outsider from participating in several crews.

## Desired outcome

Define **Guest** as an external Pi session explicitly admitted as a live
messaging participant in one or more crews. Guest is part of each crew's
conversation and presence, but remains distinct from manifest-configured
Member, carries no crew role, and gains no privileged coordination authority.

One session owns one stable Guest identity and one live callback socket. Each
crew owns an independent, revocable Guest membership binding that identity to
that crew. Joining or leaving one crew never affects another membership.

## Approved product direction

- Capability: full ordinary messaging participant. Guest can send and receive
  Follow-ups, Member Requests/Responses, and live Crew Broadcasts.
- Admission: explicit crew approval. Knowing a socket or manifest path alone
  never admits a Guest.
- Lifecycle: approved membership is restorable across Guest and crew restarts
  until Guest leaves or crew revokes it. Socket liveness determines presence.
- Authority: Guest cannot claim a Member name/role or use Member endpoints,
  durable Member Inbox, Redirect, Interrupt, crew control, or approval powers.
- Scope: every Guest operation identifies exact crew. No active/default crew is
  inferred when Guest belongs to several crews.

## Ubiquitous language

- **Guest** — external Pi session with stable identity that has explicit,
  limited participation approval from a crew; never a configured Member.
- **Guest membership** — crew-owned revocable binding between Guest identity,
  Guest callback endpoint, capabilities, and exact crew identity.
- **Guest join request** — untrusted request submitted through one live Member
  socket; it creates no membership until explicitly approved.
- **Guest approver** — exact manifest-configured Member allowed to approve,
  deny, or revoke Guests; never inferred from role.
- **Crew selector** — stable public identifier used by one Guest to select one
  joined crew without exposing filesystem or socket routes to model context.
- **Guest presence** — online/offline observation of approved Guest callback
  socket; presence is not membership, trust, acknowledgement, or authority.

## Acceptance criteria

- [ ] `UL.md` defines Guest, Guest membership, join request, approver, crew
      selector, and Guest presence, and contrasts them with Member and Intake.
- [ ] Contract supports one Guest session joined to zero, one, or many crews
      concurrently without switching or releasing another crew membership.
- [ ] Each crew has explicit stable identity and display name suitable for
      deterministic Guest selection; duplicate display names require stable
      selector rather than guessing.
- [ ] Guest name is unique inside one crew across Members and Guests; same
      stable Guest may use independently approved display name per crew.
- [ ] Join request uses one explicit live Member socket only as admission
      transport. Socket knowledge creates a pending request, never membership.
- [ ] Manifest declares exact Guest approver Member names. Missing Guest policy
      disables admission; there is no lead/PO/contact/first-online fallback.
- [ ] Approval binds expected Guest identity and callback endpoint to exact
      crew using a runtime-held capability that is never model-visible.
- [ ] Approval is crew-local and revocable. Leave/revoke invalidates capability,
      removes roster participation, and cannot affect Guest's other crews.
- [ ] Restored membership fails closed when crew identity, Guest identity,
      approval, capability, or endpoint binding no longer matches.
- [ ] Approved Guest appears distinctly in roster and presence and can use only
      Follow-up, Member Request/Response, and transient Broadcast messaging.
- [ ] Guest cannot use Inbox, Redirect, Interrupt, membership/control commands,
      Guest approval, role instructions, or implicit crew-wide authority.
- [ ] Crew common/role instruction files are not injected into multi-crew Guest
      system context in this slice; per-message instructions retain semantics.
- [ ] Guest Origin is typed and visibly labelled `(guest)`; approval authenticates
      current capability binding but does not make content trusted or grant role.
- [ ] Intake remains available for one-way offline contact delivery and is not
      silently redirected into Guest admission.
- [ ] Threat model covers guessed/stolen socket paths, replayed approvals,
      capability leakage, stale endpoints, name collision, cross-crew confusion,
      unauthorized approval/revocation, and one compromised crew.

## Threat model

- A guessed or stolen Member socket may submit a join request, but cannot create
  membership without exact Crew-local approval and a runtime-held capability.
- Approval is bound to expected Guest identity, callback endpoint, and Crew
  selector; replay, stale endpoint, renamed Crew, or changed approver fails closed.
- Guest names collide with configured Member names and other Guest names inside
  one Crew; cross-Crew names remain independent and never select by display name.
- Approval/revocation is authorized only for exact configured approver names;
  role labels, Crew contact, lead, and online state grant no authority.
- Capability and filesystem/socket routes stay outside model-visible payloads;
  Guest Origin is attribution, not content trust. A compromised Crew cannot
  mutate another Crew's membership because every binding is Crew-local.

## Implementation notes

- Contract slice owns the ubiquitous language, optional `crew` manifest projection
  (`id`, `displayName`), optional `guestAdmission.approvers`, and pure Guest
  selectors, capability allowlist, origin, and binding records.
- Both manifest versions accept the newest metadata fields. Legacy manifests may
  omit `crew`; omitted `guestAdmission` disables admission, while empty
  `approvers` is invalid. No role/contact/online fallback exists.
- TASK-0161 owns admission, callback socket lifecycle, persistence, revocation,
  and fail-closed restore. TASK-0162 owns crew-scoped Guest messaging/tool
  surfaces. No runtime command or tool behavior is changed here.

## Non-goals

- Remote network transport, public internet exposure, role/permission inheritance,
  Guest durable Inbox, automatic task assignment, common instruction inheritance,
  arbitrary capability negotiation, Guest-to-Guest private channels, or Guest
  administration of another Guest.
