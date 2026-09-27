import assert from "node:assert/strict";
import test from "node:test";
import {
	BEBOP_PROTOCOL,
	COMMAND_REGISTRY,
	currentRuntimeCompatibility,
	isMethodResult,
	commandToRequest,
	requestToCommand,
} from "./index.ts";

test("runtime compatibility is a bounded read-only correlated protocol command", () => {
	const request = commandToRequest({ type: "runtime_compatibility" }, "doctor-1");
	assert.deepEqual(request, {
		jsonrpc: "2.0",
		id: "doctor-1",
		method: "runtime.compatibility",
		params: {},
	});
	const command = requestToCommand(request);
	assert.deepEqual(command, { type: "runtime_compatibility", id: "doctor-1" });
	assert.equal(COMMAND_REGISTRY.runtime_compatibility.method, "runtime.compatibility");
});

test("runtime compatibility exposes version provenance and capabilities without secrets", () => {
	const result = currentRuntimeCompatibility();
	assert.equal(result.product, "pi-bebop");
	assert.deepEqual(result.protocol, BEBOP_PROTOCOL);
	assert.match(result.packageVersion, /^\d+\.\d+\.\d+/);
	assert.match(result.buildCommit, /^[0-9a-f]{40}$/);
	assert.ok(result.capabilities.length > 0);
	assert.equal(isMethodResult("runtime.compatibility", result), true);
	assert.equal("credentials" in result, false);
	assert.equal("socket" in result, false);
});
