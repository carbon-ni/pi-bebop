# Communicate with a crew

Bebop moves messages between independent Pi sessions. It does not assign tasks, choose workers, own Git or CI, or decide when work is done. Roles describe responsibility, not permissions; if more than one member has a role, address an exact member name.

| Need | Tool | Promise |
| --- | --- | --- |
| An answer or verdict | `send_member_request` | One correlated Response; wait with its `request_id`. |
| Share information | `send_follow_up` | Accepted delivery; no Response expected. |
| Change the next step | `redirect_member` | Guidance before the next model step, without aborting the turn. |
| Reach an offline member | `send_to_inbox` | Persist for later delivery as a Follow-up. |
| Stop harmful or stuck work | `interrupt_member` | Try to abort and deliver recovery guidance; cannot undo completed work. |
| Tell everyone else | `broadcast_to_crew` | Attempt each delivery and report each outcome; no inbox persistence. |

Online and idle are observed runtime states, not availability or progress. Accepted delivery, inbox persistence, and a Response do not prove work is complete or correct.

## Requests and waits

For a Response from the CLI, use `bebop ask <crew[/member]> <question>` or `bebop member request send` followed by `bebop member request wait`. See [Crew interaction](CREW-INTERACTION.md) for Ask outcomes and [Member Request workflow](MEMBER-REQUEST-WORKFLOW.md) for the explicit Request ID flow.

`wait_for_request_outcome` needs the exact `request_id` from `send_member_request`. It returns a Response, offline result, one nonterminal `pending-after-idle` notice, or terminal max-wait. If the wait wakes for an incoming Bebop message, process it and wait again with the **same ID**. Do not send a duplicate just because the wait ended. A request may still be live after a timeout.

`wait_for_member_idle` can wake when a member becomes idle, goes offline, times out, **or receives an incoming Bebop message**. None of these proves work is finished. Call this wait on its own rather than in a parallel tool batch, so incoming messages can be handled immediately.

Inbox messages to online members are offered on the next FIFO continuation; offline delivery waits for join, restore, or turn end. Messages at least 48 hours old are labeled stale and must be revalidated before acting.
