# Crew Interaction

This document defines the product contract for name-first Crew interaction.

## Ask

```text
bebop ask <crew-selector[/member]> <question>
```

Ask requires an authorized current joined Member or approved Guest route for the exact Crew. A Crew Locator alone never grants authority. A Crew-only target uses the manifest-authored `intake.contact`; it never guesses a lead, role, first Member, or online Member.

Ask sends exactly one correlated Member Request and waits for its correlated Response. Request IDs remain internal. Accepted means only that a live endpoint accepted the request. It does not mean seen, answered, correct, or complete.

### Bounds

| Stage | Default | Allowed |
| --- | ---: | ---: |
| Candidate probe | 300 ms | fixed |
| Discovery | 2 s total | fixed |
| Delivery RPC | 5 s | fixed |
| Post-idle Response grace | 30 s | 1–600 s |
| Total Ask wait | 120 s | 2–1,800 s, greater than grace |

`--response-grace <duration>` and `--timeout <duration>` use whole-second `ms`, `s`, or `m` values. Ask never retries a delivery whose acceptance is uncertain.

### Outcome codes

The same semantic fields and outcome codes are used by text, TOON, and JSON output.

| Code | Stage | Meaning |
| --- | --- | --- |
| `response` | response | One correlated Response was received. |
| `unknown-crew` | resolution | The exact Crew selector is unknown. |
| `unknown-member` | resolution | The exact Member is unknown. |
| `ambiguous-crew` | resolution | More than one trusted Crew matches the selector. |
| `self-target` | resolution | The caller addressed itself. |
| `invalid-manifest` | resolution | Trusted manifest data is invalid. |
| `authorization-required` | resolution | No authorized current Member or approved Guest route exists. |
| `offline-crew` | resolution | No live Crew route exists. |
| `offline-member` | resolution | The target Member is offline. |
| `route-conflict` | resolution | Canonical endpoint ownership conflicts. |
| `route-lost` | delivery/response | The resolved target route was lost. |
| `discovery-timeout` | discovery | Discovery exceeded two seconds; delivery did not start. |
| `delivery-timeout-unknown` | delivery | Acceptance is unknown; `safeRetry` is false. |
| `timeout-after-idle` | response | No Response arrived during the post-idle grace period. |
| `timeout-total` | response | No Response arrived before the total Ask timeout. |
| `malformed-response` | response | Peer output failed protocol or schema validation. |
| `cancelled` | current phase | The caller stopped local work. Delivery cancellation reports acceptance unknown and `safeRetry: false`. |

Ask output never exposes sockets, session IDs, Request IDs, capabilities, raw dependency errors, or message content in diagnostics. Answers preserve exact UTF-8 content and instruction order.

## Lower-level Member Request

The explicit `bebop member request send` and `bebop member request wait` commands remain available for workflows that need the opaque Request ID and manual re-wait behavior. The simple Ask path hides that lifecycle while preserving its correlation guarantees.
