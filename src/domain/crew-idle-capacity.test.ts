import test from "node:test";
import assert from "node:assert/strict";
import { createCrewIdleCapacity } from "./crew-idle-capacity.ts";

test("crew idle capacity permits one lease and releases idempotently", () => {
	const capacity = createCrewIdleCapacity();
	const lease = capacity.acquire("member-idle-tool");
	assert.ok(lease);
	assert.equal(lease.owner, "member-idle-tool");
	assert.equal(typeof lease.token, "symbol");
	assert.equal(capacity.acquire("crew-idle-tool"), null);
	assert.equal(lease.release(), true);
	assert.equal(lease.release(), false);
	const replacement = capacity.acquire("crew-idle-tool");
	assert.ok(replacement);
	assert.notEqual(replacement.token, lease.token);
	assert.equal(lease.release(), false, "a stale lease cannot release its replacement");
	assert.equal(replacement.release(), true);
});
