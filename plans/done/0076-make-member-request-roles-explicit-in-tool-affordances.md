---
id: TASK-0076
title: Make Member request roles explicit in tool affordances
status: done
depends_on: []
priority: high
tags: [member-request, tools, affordance, messaging, context, ux, tdd]
---

# Make Member request roles explicit in tool affordances

## Problem

Agents used ordinary `send_follow_up` for QA work explicitly requiring a report,
then recipient called requester-side `wait_for_request_outcome`. This is a
product affordance failure, not agent fault. Tool guidance conflicts:
`send_follow_up` advertises itself as default normal path, while later context
says use `send_member_request` when Response is required. Member request and
ordinary Follow-up also render through same generic session-message surface, so
requester/responder ownership is not structurally obvious.

## Context

Make transient request roles explicit without manifest permissions:

- **Requester** sends Member request and alone waits for its Request outcome.
- **Responder** receives Member request, performs requested work, and sends one
  correlated Response.

These are per-request roles, not Crew roles or authority. Preserve ordinary
Follow-up for information not requiring correlated Response.

## Acceptance criteria

- [ ] Tests first reproduce exact misuse: sender asks for report through Follow-up, recipient sees generic message, and recipient chooses/calls requester-only wait path.
- [ ] `send_follow_up` description no longer says unconditional/default coordination; it says information-only/no correlated Response and directs assignments/questions requiring one report to `send_member_request`.
- [ ] `send_member_request` description says requester-side and is recommended for any message whose sender requires one answer/report/verdict/evidence response.
- [ ] `respond_to_member_request` description says responder-side and only for inbound Member request.
- [ ] Request-outcome wait description says requester-side and “call only after current member successfully sent a Member request”; it explicitly forbids handling inbound assignment/message.
- [ ] Decide through UL review whether tool becomes `wait_for_sent_request_outcome`; if retained, label/description must make sent/outbound ownership equally obvious without transport jargon.
- [ ] Inbound Member request is structurally distinguishable in model context and UI from ordinary Follow-up, with bounded semantic marker and instruction to respond using `respond_to_member_request`; callback routes remain hidden.
- [ ] Ordinary Follow-up is structurally identified as no correlated Response expected; message content requesting a report is never heuristically parsed or silently upgraded.
- [ ] Member request marker carries Request ID/semantic intent only, never requester socket/session/manifest path or authentication claim.
- [ ] Membership context contains one non-contradictory requester→wait / responder→respond rule and does not rely on Crew role such as lead/QA.
- [ ] Calling request-outcome wait without current member's pending outbound request fails synchronously with `no-pending-member-requests` and recovery: act on inbound work, send a new Member request, or stop.
- [ ] Tool ordering/prompt presentation does not place contradictory “default” guidance ahead of request-specific guidance; packaged extension test asserts final descriptions together.
- [ ] Happy integration proves requester sends QA request, responder sees Member request marker, responder responds, and requester alone receives outcome; negative integration proves ordinary Follow-up creates no request state.
- [ ] No model-content inference, automatic conversion, role permission, hidden task tracking, polling, sleep, or completion claim is introduced.
- [ ] UL/docs/examples update Requester/Responder as transient request roles and show correct QA handoff.
- [ ] Focused renderer/context/tool/package tests, touched coverage, and fresh final watcher gate pass.

## Out of scope

- Changing request terminal outcomes/deadlines, making all Follow-ups require
  Response, task workflow inference, CLI request parity, or authenticating
  Origin.
