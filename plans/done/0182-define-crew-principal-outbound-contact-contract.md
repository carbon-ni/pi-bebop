---
id: TASK-0182
title: Define Crew Principal outbound contact contract
status: done
depends_on: [TASK-0171]
priority: high
tags: [product, crew, principal, outbound, messaging, security, ubiquitous-language]
---

# Define Crew Principal outbound contact contract

## Problem
An external coordinator can contact a Crew through one-way Crew Intake, but the Crew cannot contact that coordinator without raw pi-intray commands, session IDs, and transport coupling. Pi Bebop needs an honest first-class crew-to-principal contact boundary that grants neither Crew membership nor broad callback capability.

## User story

As an external coordinator directing a Crew, I want the Crew to send me one-way updates through a first-class product contact so that Crew members do not need raw pi-intray commands, session IDs, or socket knowledge.

## Product boundary

This is adjacent to name-first Crew interaction, not a relaxation of Crew Intake or Guest membership:

- **Crew Intake** remains external actor → configured Crew contact.
- **Principal contact** is configured Crew → external principal, one-way.
- **Guest membership** remains approved two-way Crew messaging participation.
- A Principal contact receives no Member role, Crew instructions, inbound send permission, Request/Response right, Broadcast right, approval right, or implicit authority over the Crew.

The manifest may author the expected Principal identity, display label, outbound policy, and route-binding method. Runtime endpoint/capability material must not appear in the manifest, prompt, default output, or message content. A route-binding credential may protect destination integrity, but it authorizes receipt only and is never a Crew access capability.

## Decisions this contract must make

- Canonical name: Principal, coordinator contact, or another term that does not imply inferred command authority.
- Manifest schema, whether absence disables outbound contact, and migration/version behavior.
- How an expected manifest-authored identity binds, rotates, and revokes one live external destination without depending on pi-intray runtime internals.
- Whether delivery is transient Accepted, durable Persisted, or caller-selected; FIFO ordering, retry, deduplication, cancellation, size, and retention bounds.
- Offline behavior and honest terminal states: persisted, pending, handed-to-principal, rejected, expired, revoked, and unknown.
- External rendering and attribution: exact sending Crew/Member, sent/delivered age, and explicit one-way/no-response guarantee.
- Public CLI/tool surface, including actionable setup and recovery without session IDs, sockets, or raw protocol methods.
- Trust and threat model for route hijack, stale binding, symlink/path escape, replay, cross-Crew leakage, and a principal attempting to use the outbound route for inbound authority.
- Optional adapter boundary if pi-intray interop is ever supported; core pi-bebop must remain independent.

## Contract

`docs/CREW-PRINCIPAL.md` is the normative product contract. It defines Principal as an outbound product recipient, fixes the manifest and authorization boundary, and keeps route binding independent from Member, Guest, Intake, Inbox, Ask, and transport identity.

## Acceptance criteria

- [x] `UL.md` defines Principal contact, Principal identity, Principal route binding, and Principal message without conflating them with Crew contact, External actor, Guest, Member, Requester, or transport endpoint.
- [x] `docs/CREW-PRINCIPAL.md` has a state table covering missing config, unbound/revoked/stale destination, principal offline, Crew member unauthorized, concurrent sends, retry/replay, route rotation, duplicate completion, expiration, cancellation, and cross-Crew mismatch.
- [x] The contract identifies exact manifest-authored fields and a safe migration strategy; no role, lead, Crew contact, first/online Member, environment variable, session alias, or previous recipient is inferred.
- [x] A Principal route is outbound-only. Possessing or binding it grants no Crew membership, Guest capability, inbound message right, Request/Response right, role, instructions, or approval authority.
- [x] Core routing uses a pi-bebop-owned application/infra seam and protocol; it does not shell out to `pi`, require pi-intray, or expose `--control-session`, `--send-session-message`, session IDs, or sockets in normal use.
- [x] Persistence, handoff, acknowledgement, response, and task completion remain distinct. One-way delivery never promises a reply or claims the principal read/acted on content.
- [x] Durable storage has deterministic FIFO ordering, bounded capacity/retention, stable deduplication identity, evidence-gated removal, atomic writes, and explicit offline/expiry behavior.
- [x] Default text/TOON/JSON show only product identity, guarantee state, and freshness; diagnostics redact endpoint, credential, raw protocol, and message content.
- [x] Errors include one safe runnable corrected command for missing setup, offline/unbound destination, invalid timeout/retention, and version mismatch where possible.
- [x] Happy and unhappy paths are testable without live pi-intray or external network dependencies.
- [ ] Security, product, development, and QA approve the contract before implementation tasks are created.

## Review status

- Product: Mary (PO) approved the contract at exact commit `e334115` on 2026-09-06. The canonical term, fail-closed authority boundary, bounded delivery states, privacy contract, recovery commands, and pi-intray independence are accepted.
- Security/lead: Mony approved at `73950a1` on 2026-09-06. The contract fails closed for absent configuration, empty sender allowlists, unbound/stale/revoked bindings, and cross-Crew identity mismatch; requires trusted binding mutation, explicit rotation/revocation, stable-message replay idempotency, outbound-only authority, and redacted output without endpoints, credentials, session IDs, sockets, or message content.
- Development: pending feasibility review of the application/infra seam and deterministic outbox evidence.
- QA: pending independent review of the state table and implementation-testability checklist.
- Implementation tasks remain blocked until the pending Security, Development, and QA reviews approve the final checklist.

## Non-goals

Implementing transport, making the principal a Crew participant, two-way chat, task tracking, progress inference, remote-network identity, or preserving the raw pi-intray workaround as the product API.

## Source feedback

Captured 2026-09-05 from an external Crew coordinator. Current workaround shells out to `pi -p --intray --control-session <id> --send-session-message ...`; this is out-of-band and couples Crew work to pi-intray transport internals.

