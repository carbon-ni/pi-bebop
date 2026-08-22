---
name: pi-intray
description: >
  Use pi-intray to message joined crew members by role or address a specific session/socket.
---

# Pi Intray Chat

## Joined crew

When the current session is joined to a trusted crew, use the compact role-aware tool:

```text
send_to_member({ member, message, mode?, wait_until?, reply_behavior? })
```

Resolve recipients from the configured crew manifest. The tool reports the destination role and supports synchronous or asynchronous response policies. With `allow_reply`, use the single `sender_info` block to call `send_to_session` back to the sender.

## Explicit session targeting

Use `send_to_session` when addressing a known session or repository-local socket path. It supports `send`, `get_message`, and `clear`, plus callback metadata for explicit asynchronous `allow_reply` flows; callback messages include one machine-readable `sender_info` block.

## CLI bridge

Startup scripts may use:

```bash
pi -p --in --control-session <target> \
  --send-session-message "hello" \
  --send-session-wait message_processed
```

Use `/intray list` for live session discovery when a direct session target is not known.
