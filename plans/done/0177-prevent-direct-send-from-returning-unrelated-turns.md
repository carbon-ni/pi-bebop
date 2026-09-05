---
id: TASK-0177
title: Prevent direct send from returning unrelated turns
status: done
depends_on: []
priority: high
tags: [cli, messaging, correlation, correctness, regression, tdd]
---

# Prevent direct send from returning unrelated turns

## Problem

A user observed `send --wait turn_end` return an unrelated earlier response while the target was busy. Returning uncorrelated content as the result of a send violates the delivery guarantee and can cause callers to act on the wrong answer.

## Priority

P0 correctness investigation. Do not wait for the Commander or name-routing refactors.

## Acceptance criteria

- [x] A RED integration test reproduces or mechanically bounds the reported sequence: target has an earlier assistant result, target becomes busy, caller sends with `--wait turn_end`, and the returned content/turn identity is inspected.
- [x] The source of every returned assistant response is proven by a delivery-specific correlation identifier. A monotonic turn index/boundary counts only if the runtime contract explicitly guarantees causal ownership by this exact delivery despite queued work and concurrent sends; temporal ordering alone is not correlation.
- [x] The RED oracle includes queued work and concurrent sends and fails any implementation that accepts a merely newer turn as this send's answer.
- [x] If the Pi API cannot prove correlation, `send --wait turn_end` stops returning assistant content and either reports only its provable delivery lifecycle outcome or rejects the mode with an actionable `pi-bebop ask <crew[/member]> ...` replacement.
- [x] Accepted, queued, completed, and correlated Response remain distinct; `completed` never means this message was answered.
- [x] Busy, idle, queued Follow-up, Redirect, retry, timeout, abort, stale prior output, and two concurrent sends are deterministic and covered through the real CLI/RPC boundary.
- [x] No fallback maps a global `turn_end` event or latest assistant message to the current send.
- [x] Help and delivery documentation state the exact guarantee and no longer imply correlation where none exists.
- [x] Errors/results contain no unrelated message content, hidden session state, or raw dependency payload.
- [x] Regression risk and all focused/final gates pass on an unchanged exact HEAD.

## Evidence

- Implementation: `a76a6a2`; CLI-only recovery correction: `1bd5f19`.
- RED real Unix-socket CLI characterization proves prior/global `turn_end` content cannot escape; rejection occurs before transport.
- Independent review: Mony approved exact HEAD `1bd5f19`; focused 107/107 and typecheck pass.
- External `make all` watcher generation 908 passed on unchanged HEAD.

## Non-goals

Implementing the new name-first Ask command, inferring whether an answer is correct, or changing ordinary Member Request correlation.
