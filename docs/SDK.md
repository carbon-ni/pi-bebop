# Node.js SDK

Use the SDK from Node.js ESM or TypeScript. It selects an already-running joined, trusted source session; it does not launch a crew.

```bash
npm install @carbon-ni/pi-bebop
```

```ts
import { createBebopClient } from "@carbon-ni/pi-bebop/sdk";

const bebop = createBebopClient();
const sources = await bebop.listSources({ timeoutMs: 10_000 });
const source = sources.find((item) => item.state === "joined" && item.trusted);
const crew = await bebop.selectSource({ session: process.env.PI_SESSION_ID ?? source?.session });

const answer = await crew.ask("developer", {
	question: "Review the change and report blockers",
	instructions: ["Be concise"],
});

if (answer.status === "answered") console.log(answer.message, answer.instructions);
else if (!answer.safeRetry) console.warn(`Ask ended as ${answer.code}; do not send a duplicate`);
```

Select a trusted source explicitly or use `PI_SESSION_ID` as a fallback. The SDK never reads a manifest or accepts socket paths. The selected source owns membership, trust, target resolution, and storage.

## Operations

- `getMemberStatus` reports observations, not task progress.
- `getMemberLastMessage` returns a bounded snapshot of recorded assistant text; it does not read full history.
- `sendFollowUp` confirms accepted delivery; `sendToInbox` confirms persistence. Neither means read, acted on, or completed.
- `ask` sends exactly one correlated Member Request and hides its Request ID. Only `answered` is a Response. Accepted `offline` and `timeout` outcomes have `safeRetry: false`.

```ts
const status = await crew.getMemberStatus("developer");
const snapshot = await crew.getMemberLastMessage("developer", { timeoutMs: 5_000 });
await crew.sendFollowUp("developer", { message: "Build finished" });
await crew.sendToInbox("developer", { message: "Context for your next startup" });
```

## Timeouts and cancellation

Ask defaults to a 30-second post-idle Response grace and a 120-second total wait. `responseGraceSeconds` is bounded to 1–600; `totalWaitSeconds` to 2–1800 and must be greater than grace. A local total-budget expiry after acceptance returns `timeout-total` with `safeRetry: false`: the remote Request may remain live. Route loss returns `route-lost`. Do not retry either delivery without reconciling its outcome.

Operations accept an `AbortSignal` and a finite `timeoutMs`. The SDK never retries effects automatically. If cancellation happens after acceptance, the outcome is unknown:

```ts
import { BebopClientError } from "@carbon-ni/pi-bebop/sdk";

const cancellation = new AbortController();
const pending = crew.sendFollowUp("developer", { message: "Cancel if still pending" }, { signal: cancellation.signal });
setTimeout(() => cancellation.abort(), 100);

try {
	await pending;
} catch (error) {
	if (!(error instanceof BebopClientError)) throw error;
	if (error.code === "aborted") console.warn("Cancelled before acceptance");
	else if (error.code === "outcome-unknown") console.warn("Reconcile delivery; do not blindly retry");
	else throw error;
}
```

See [Crew interaction](CREW-INTERACTION.md) for correlated Request outcomes and [the SDK interface map](SDK-INTERFACE-MAP.md) for code ownership.
