import assert from "node:assert/strict";
import test from "node:test";
import { runSecurityCheck, toExitCode } from "./security-check.mjs";

const VULNERABILITIES_JSON = JSON.stringify({
	metadata: { vulnerabilities: { info: 0, low: 1, moderate: 1, high: 0, critical: 0, total: 2 } },
});
const ENDPOINT_ERROR_JSON = JSON.stringify({
	message: "audit endpoint returned an error",
	method: "POST",
	statusCode: 400,
	body: "Invalid package tree, run npm install to rebuild your package-lock.json",
});

test("clean audits pass on the first attempt without retry delays", async () => {
	const runAudit = async () => ({ status: 0, stdout: "{}", stderr: "" });
	const delays = [];
	const { outcome, attempts } = await runSecurityCheck({ runAudit, delay: (ms) => delays.push(ms) });
	assert.deepEqual(outcome, { kind: "clean" });
	assert.equal(attempts, 1);
	assert.deepEqual(delays, []);
	assert.equal(toExitCode(outcome), 0);
});

test("vulnerability findings fail the gate immediately without retrying", async () => {
	const runAudit = async () => ({ status: 1, stdout: VULNERABILITIES_JSON, stderr: "" });
	const delays = [];
	const { outcome, attempts } = await runSecurityCheck({ runAudit, delay: (ms) => delays.push(ms) });
	assert.equal(outcome.kind, "vulnerabilities");
	assert.equal(outcome.counts.total, 2);
	assert.equal(outcome.report, VULNERABILITIES_JSON);
	assert.equal(attempts, 1);
	assert.deepEqual(delays, []);
	assert.equal(toExitCode(outcome), 1);
});

test("audit endpoint failures are retried with deterministic backoff before recovery", async () => {
	let call = 0;
	const runAudit = async () => {
		call += 1;
		return call === 1
			? { status: 1, stdout: ENDPOINT_ERROR_JSON, stderr: "npm error audit endpoint returned an error" }
			: { status: 0, stdout: "{}", stderr: "" };
	};
	const delays = [];
	const { outcome, attempts } = await runSecurityCheck({ runAudit, delay: (ms) => delays.push(ms) });
	assert.deepEqual(outcome, { kind: "clean" });
	assert.equal(attempts, 2);
	assert.deepEqual(delays, [2000]);
	assert.equal(toExitCode(outcome), 0);
});

test("persistent endpoint failures are reported as unavailable with exact evidence", async () => {
	const runAudit = async () => ({
		status: 1,
		stdout: ENDPOINT_ERROR_JSON,
		stderr: "npm error audit endpoint returned an error",
	});
	const delays = [];
	const { outcome, attempts } = await runSecurityCheck({
		runAudit,
		delay: (ms) => delays.push(ms),
		attempts: 3,
	});
	assert.equal(outcome.kind, "unavailable");
	assert.equal(outcome.evidence.length, 3);
	assert.ok(outcome.evidence[0].includes("attempt 1"));
	assert.ok(outcome.evidence[0].includes("400"));
	assert.ok(outcome.evidence[0].includes("Invalid package tree"));
	assert.equal(attempts, 3);
	assert.deepEqual(delays, [2000, 4000]);
	assert.equal(toExitCode(outcome), 0);
});

test("unparseable audit output is treated as unavailable, never as findings", async () => {
	const runAudit = async () => ({
		status: 1,
		stdout: "npm error audit endpoint returned an error",
		stderr: "npm error A complete log of this run can be found in: npm-debug.log",
	});
	const { outcome } = await runSecurityCheck({ runAudit, delay: async () => {} });
	assert.equal(outcome.kind, "unavailable");
	assert.ok(outcome.evidence[0].includes("audit endpoint returned an error"));
	assert.equal(toExitCode(outcome), 0);
});
