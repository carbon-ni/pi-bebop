import test from "node:test";
import assert from "node:assert/strict";
import { createCrewIdleCapacity } from "./crew-idle-capacity.ts";

test("crew idle capacity permits one lease and releases idempotently", () => {
	const capacity = createCrewIdleCapacity();
	const lease = capacity.acquire();
	assert.ok(lease);
	assert.equal(capacity.acquire(), null);
	lease.release();
	lease.release();
	assert.ok(capacity.acquire());
});
