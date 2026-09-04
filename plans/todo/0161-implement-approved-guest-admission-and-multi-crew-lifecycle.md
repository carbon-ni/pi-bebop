---
id: TASK-0161
title: Implement approved Guest admission and multi-crew lifecycle
status: todo
depends_on: [TASK-0160]
priority: high
tags: [crew, guest, admission, multi-crew, lifecycle, cli, security, tdd]
---

# Implement approved Guest admission and multi-crew lifecycle

## Problem

After the Guest contract is approved, Bebop needs a secure restorable runtime
that admits one external session to several crews without claiming Member
endpoints or leaking one crew's authority into another.

## Desired interface

Guest-facing commands use one obvious namespace and never replace existing
Member join:

```text
/guest join <live-member-socket> --as <guest-name>
/guest crews
/guest leave <crew-selector>
```

`join` returns `pending <request-id>` until approved. Repeating same request is
idempotent. `crews` lists every pending/approved membership in deterministic
crew order with stable selector, display name, Guest name, and online/offline
state; it never exposes capabilities or socket paths.

Member-facing commands operate only on current joined crew:

```text
/crew guests
/crew guest approve <request-id>
/crew guest deny <request-id>
/crew guest remove <guest-name>
```

`guests` separates pending and approved Guests. Approve/deny/remove require
current Member to be an exact configured Guest approver. All commands are
non-agent-turn control operations with structured CLI parity.

Pi also supports repeatable startup requests without inventing an active crew:

```bash
pi --intray --guest-as Alex \
  --guest-join /path/to/crew-a/member.sock \
  --guest-join /path/to/crew-b/member.sock
```

Each `--guest-join` creates or resumes one independent pending/approved binding.
Startup reports each crew outcome separately; one unavailable crew does not
roll back another. A resumed Guest session restores approved memberships and
publishes its new callback endpoint without repeating approval.

## Acceptance criteria

- [ ] TDD starts with join request, approval, multi-crew restore, leave/revoke,
      unauthorized action, collision, replay, stale endpoint, and partial
      recovery paths using injected clocks/IDs and no wall-clock sleeps.
- [ ] Guest join targets one explicit live Member socket and validates that
      endpoint's current crew identity before creating pending request.
- [ ] Join response contains safe crew identity, request ID, and `pending`; it
      never says joined before approval or exposes manifest/capability internals.
- [ ] Same Guest/crew/name/endpoint pending request is idempotent; changed or
      replayed identity is rejected explicitly.
- [ ] Only exact configured approvers can approve, deny, list sensitive pending
      details, or revoke. Roles and Crew contact never imply approval authority.
- [ ] Approval produces one crew-local capability stored outside model context;
      secrets are redacted from tools, TUI, logs, roster, errors, and reports.
- [ ] Runtime stores zero-to-many Guest memberships keyed by stable crew
      identity. Joining/restoring/leaving one cannot mutate another.
- [ ] Restart restores only still-approved matching memberships; stale,
      revoked, moved, tampered, or mismatched records fail closed per crew while
      preserving independent valid memberships.
- [ ] Guest callback endpoint is never published as or allowed to replace a
      configured Member endpoint.
- [ ] `/guest join|crews|leave` and `/crew guests|guest approve|deny|remove`
      follow exact interface above or document a simpler equivalent with same
      unambiguous states and self-correcting errors.
- [ ] `pi --intray --guest-as <name> --guest-join <socket>` supports repeatable
      `--guest-join` flags, reports each outcome independently, and rejects
      missing/duplicate/conflicting arguments before sending any request.
- [ ] Guest startup flags imply no default crew and cannot be combined with
      Member `--crew-role`/`--crew-socket` membership in this slice.
- [ ] Resuming same Guest restores all still-approved crew bindings and safely
      updates callback endpoint; a new unrelated Pi session cannot inherit them.
- [ ] CLI provides non-interactive equivalents and text/TOON/JSON formats with
      stable error codes and token-light default output.
- [ ] Roster/presence distinguish pending, approved-online, approved-offline,
      left, and revoked without treating socket liveness as approval.
- [ ] Concurrent approve/revoke/join/leave is deterministic, atomic per crew,
      and leaves no orphaned capability or symlink after crash recovery.
- [ ] Existing single Member membership, Crew Intake, socket ownership, and
      trust boundaries remain regression-covered and backward compatible.
- [ ] Package smoke, storage/restart integration, architecture, coverage, final
      watcher, and independent exact-head QA gates pass.

## Constraints

- Guest registry and capabilities are Infra; admission/lifecycle policy is
  Domain/Application; `src/extension.ts` owns dependency wiring.
- Reuse validated RPC framing and bounded payload/path rules.
- Random capability generation must be injected and deterministic in tests.

## Non-goals

- Guest messaging payloads (TASK-0162), remote sockets, auto-approval, role-based
  approvers, Guest role files, or migration of external Intake messages.
