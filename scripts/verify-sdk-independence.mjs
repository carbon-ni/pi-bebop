import assert from "node:assert/strict";
import { access } from "node:fs/promises";

await access(new URL("../dist/sdk.js", import.meta.url));
const sdk = await import("../dist/sdk.js");

assert.equal(typeof sdk.createBebopClient, "function");
assert.equal(typeof sdk.createInProcessMemberStatusOperation, "function");
assert.equal(typeof sdk.createInProcessFollowUpOperation, "function");

// In-process factories are executable without PI_SESSION_ID, socket discovery,
// Commander, or Pi startup. Runtime authority is supplied by the injected
// surface and remains live per operation call.
const status = sdk.createInProcessMemberStatusOperation({
	surface: {
		getMembership: () => null,
		isTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		probeEndpoint: async () => false,
		requestStatus: async () => {
			throw new Error("status transport must not run");
		},
		now: () => new Date(0).toISOString(),
	},
});
await assert.rejects(status.getMemberStatus("developer"), (error) => error?.code === "not-joined");

const followUp = sdk.createInProcessFollowUpOperation({
	surface: {
		getMembership: () => null,
		isTrusted: () => true,
		approvedGuests: () => [],
	},
	message: {},
});
await assert.rejects(followUp.sendFollowUp("developer", { message: "proof" }), (error) => error?.code === "not-joined");

console.log(
	"SDK independence passed: packed import and in-process authority boundaries are executable without host context",
);
