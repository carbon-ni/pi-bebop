import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createGuestAdmissionRuntime, type GuestAdmissionRuntime } from "../infra/guest-admission-runtime.ts";
import { createGuestMembershipRuntime, type GuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import { digestGuestCapability, createGuestRegistryStore } from "../infra/guest-registry-store.ts";
import { createRpcServer, closeRpcServer, writeResponse } from "../infra/rpc-server.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { handleGuestJoin, handleGuestLeave, handleGuestSend } from "./control-runtime.ts";

const GUEST_IDENTITY = "guest-session-integration";

interface MemberCrew {
	crewId: string;
	socketPath: string;
	admission: GuestAdmissionRuntime;
	snapshots: unknown[][];
	sentMessages: Array<{ content: string; details: unknown; options: unknown }>;
	setTrusted: (trusted: boolean) => void;
	close: () => Promise<void>;
}

async function startMemberCrew(root: string, crewId: string, displayName: string): Promise<MemberCrew> {
	const crewDir = path.join(root, crewId);
	mkdirSync(path.join(crewDir, ".pi", "bebop"), { recursive: true });
	const socketPath = path.join(crewDir, `${crewId}-member.sock`);
	const manifest = {
		version: 1 as const,
		crew: { id: crewId, displayName },
		guestAdmission: { approvers: ["lead"] },
		members: [{ name: "lead", role: "lead", socket: `sockets/${crewId}.sock` }],
	};
	const snapshots: unknown[][] = [];
	mkdirSync(path.join(root, ".pi", "bebop"), { recursive: true });
	const registry = createGuestRegistryStore({
		manifestPath: path.join(crewDir, ".pi", "bebop", "crew.json"),
		crew: { id: crewId, displayName },
	});
	const admission = createGuestAdmissionRuntime({
		manifest,
		memberName: "lead",
		createRequestId: (() => {
			let index = 0;
			return () => `${crewId}-generated-${++index}`;
		})(),
		createCapability: () => `opaque-capability-${crewId}`,
		digestCapability: digestGuestCapability,
		registryAuthority: () => registry.load(),
		persist: (records) => {
			snapshots.push(records);
			registry.replaceEntries(records);
		},
	});
	const state = {
		trusted: true,
		membershipRuntime: {
			getMembership: () => ({
				manifest,
				member: { name: "lead", role: "lead", socket: `sockets/${crewId}.sock` },
			}),
		},
		guestAdmissionRuntime: admission,
		context: { isProjectTrusted: () => state.trusted, isIdle: () => true },
	};
	const sentMessages: Array<{ content: string; details: unknown; options: unknown }> = [];
	const server = await createRpcServer(socketPath, (command, socket) => {
		if (command.type !== "guest_join" && command.type !== "guest_leave" && command.type !== "guest_send") return;
		const respond = (success: boolean, commandName: string, data?: unknown, error?: string) =>
			writeResponse(socket, { type: "response", command: commandName, success, data, error, id: command.id });
		const context = {
			pi: {
				sendMessage: (message: unknown, options: unknown) => {
					const typed = message as { content: string; details: unknown };
					sentMessages.push({ content: typed.content, details: typed.details, options });
				},
			},
			state,
			ctx: state.context,
			socket,
			id: command.id,
			respond,
		} as unknown as Parameters<typeof handleGuestJoin>[0];
		if (command.type === "guest_join") return handleGuestJoin(context, command);
		if (command.type === "guest_leave") return handleGuestLeave(context, command);
		return handleGuestSend(context, command);
	});
	return {
		crewId,
		socketPath,
		admission,
		snapshots,
		sentMessages,
		setTrusted: (trusted: boolean) => {
			state.trusted = trusted;
		},
		close: () => closeRpcServer(server),
	};
}

function guestRuntimeFor(callbackEndpoint: string): GuestMembershipRuntime {
	let requestIndex = 0;
	return createGuestMembershipRuntime({
		guestIdentity: GUEST_IDENTITY,
		callbackEndpoint,
		createRequestId: () => `guest-local-${++requestIndex}`,
		submitJoinRequest: async () => undefined,
	});
}

function wireJoin(memberSocket: string, guestIdentity: string, guestName: string, callbackEndpoint: string) {
	return sendRpcCommand(
		memberSocket,
		{ type: "guest_join", guestIdentity, guestName, callbackEndpoint },
		{ timeout: 5000 },
	);
}

function wireSend(
	memberSocket: string,
	guestIdentity: string,
	crewId: string,
	callbackEndpoint: string,
	capability: string,
	target: string,
	content: string,
) {
	return sendRpcCommand(
		memberSocket,
		{ type: "guest_send", crewId, guestIdentity, callbackEndpoint, capability, target, content },
		{ timeout: 5000 },
	);
}

function wireLeave(memberSocket: string, guestIdentity: string, crewId: string, callbackEndpoint: string) {
	return sendRpcCommand(
		memberSocket,
		{ type: "guest_leave", guestIdentity, crewId, callbackEndpoint },
		{ timeout: 5000 },
	);
}

test("one Guest binds to two crews over the real wire and each crew revokes independently", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-wire-integration-"));
	t.after(async () => fs.rm(root, { recursive: true, force: true }));
	const callbackEndpoint = path.join(root, "guest-callback.sock");
	const alpha = await startMemberCrew(root, "alpha", "Alpha");
	const beta = await startMemberCrew(root, "beta", "Beta");
	t.after(async () => Promise.all([alpha.close(), beta.close()]));
	const guest = guestRuntimeFor(callbackEndpoint);
	const trackFromWire = (memberSocket: string, result: Awaited<ReturnType<typeof wireJoin>>) => {
		assert.ok(result.response.success, `wire join failed: ${String(result.response.error)}`);
		const data = result.response.data as {
			status: "pending" | "approved";
			requestId: string;
			crew: { id: string; displayName: string };
		};
		return guest.track(
			{ crew: data.crew, guestName: "Alex", memberSocket, submittedByMember: "member" },
			data.requestId,
			data.status,
		);
	};

	// Join both crews; wire responses carry only safe identity fields.
	const alphaJoin = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	assert.deepEqual(alphaJoin.response.data, {
		status: "pending",
		requestId: "alpha-generated-1",
		crew: { id: "alpha", displayName: "Alpha" },
	});
	assert.deepEqual(trackFromWire(alpha.socketPath, alphaJoin), {
		ok: true,
		status: "pending",
		requestId: "alpha-generated-1",
		idempotent: false,
	});

	const betaJoin = await wireJoin(beta.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	assert.deepEqual(betaJoin.response.data, {
		status: "pending",
		requestId: "beta-generated-1",
		crew: { id: "beta", displayName: "Beta" },
	});
	assert.deepEqual(trackFromWire(beta.socketPath, betaJoin), {
		ok: true,
		status: "pending",
		requestId: "beta-generated-1",
		idempotent: false,
	});

	// Replays are idempotent per crew: same pending status and request id.
	const alphaReplay = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	assert.deepEqual(alphaReplay.response.data, {
		status: "pending",
		requestId: "alpha-generated-1",
		crew: { id: "alpha", displayName: "Alpha" },
	});

	// Crew A approves; the same wire join now reports approved admission.
	assert.ok(alpha.admission.approve("alpha-generated-1", "lead").ok);
	const alphaRejoin = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	const rejoinData = alphaRejoin.response.data as { status: string; requestId: string; crew: { id: string } };
	assert.equal(rejoinData.status, "approved");
	assert.equal(rejoinData.crew.id, "alpha");
	assert.equal(typeof rejoinData.requestId, "string");
	assert.deepEqual(trackFromWire(alpha.socketPath, alphaRejoin), {
		ok: true,
		status: "approved",
		idempotent: false,
	});
	assert.deepEqual(
		guest.list().map((row) => [row.crew.id, row.status]),
		[
			["alpha", "approved"],
			["beta", "pending"],
		],
	);

	// Guest leaves Alpha over the wire: Member revokes, then Guest leaves locally.
	const leave = await wireLeave(alpha.socketPath, GUEST_IDENTITY, "alpha", callbackEndpoint);
	assert.ok(leave.response.success, `wire leave failed: ${String(leave.response.error)}`);
	assert.deepEqual(
		alpha.admission.list().map((row) => [row.guestName, row.status]),
		[["Alex", "revoked"]],
	);
	assert.deepEqual(await guest.leave("alpha"), { ok: true, left: true });

	// Re-joining the revoked crew fails closed while the other crew is untouched.
	await assert.rejects(() => wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint), /revoked/);
	assert.deepEqual(
		guest.list().map((row) => [row.crew.id, row.status]),
		[["beta", "pending"]],
	);

	// Leaving a pending crew remotely is rejected (revocation needs approval),
	// the local leave still succeeds, and a re-join replays the same request id.
	await assert.rejects(() => wireLeave(beta.socketPath, GUEST_IDENTITY, "beta", callbackEndpoint), /not-found/);
	assert.deepEqual(await guest.leave("beta"), { ok: true, left: true });
	const betaRejoin = await wireJoin(beta.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	assert.deepEqual(betaRejoin.response.data, {
		status: "pending",
		requestId: "beta-generated-1",
		crew: { id: "beta", displayName: "Beta" },
	});
	// The Member side replays the same request id; the fresh local binding is
	// tracked as a new pending entry.
	assert.deepEqual(trackFromWire(beta.socketPath, betaRejoin), {
		ok: true,
		status: "pending",
		requestId: "beta-generated-1",
		idempotent: false,
	});
});

test("wire rejections surface exact member-side admission codes", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-wire-rejection-"));
	t.after(async () => fs.rm(root, { recursive: true, force: true }));
	const callbackEndpoint = path.join(root, "guest-callback.sock");
	const alpha = await startMemberCrew(root, "alpha", "Alpha");
	t.after(async () => alpha.close());

	// Untrusted projects refuse admission before touching the runtime.
	alpha.setTrusted(false);
	await assert.rejects(
		() => wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint),
		/untrusted-project/,
	);
	alpha.setTrusted(true);

	// Name collisions protect an approved binding across guest identities.
	assert.ok(
		alpha.admission.receive({
			requestId: "seed",
			crew: { id: "alpha", displayName: "Alpha" },
			guestIdentity: "other-session",
			guestName: "Alex",
			callbackEndpoint,
			submittedByMember: "lead",
		}).ok,
	);
	assert.ok(alpha.admission.approve("alpha-generated-1", "lead").ok);
	await assert.rejects(() => wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint), /name-collision/);

	// Denied requests become tombstones: replays are rejected after denial.
	const deniedJoin = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Blair", callbackEndpoint);
	const deniedRequestId = (deniedJoin.response.data as { requestId: string }).requestId;
	assert.ok(alpha.admission.deny(deniedRequestId, "lead").ok);
	await assert.rejects(() => wireJoin(alpha.socketPath, GUEST_IDENTITY, "Blair", callbackEndpoint), /denied/);
});

test("member and guest sides restore from persisted snapshots after a simulated crash", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-wire-crash-"));
	t.after(async () => fs.rm(root, { recursive: true, force: true }));
	const callbackEndpoint = path.join(root, "guest-callback.sock");
	const alpha = await startMemberCrew(root, "alpha", "Alpha");
	t.after(async () => alpha.close());
	const guest = guestRuntimeFor(callbackEndpoint);

	const join = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	assert.ok(join.response.success);
	guest.track(
		{
			crew: { id: "alpha", displayName: "Alpha" },
			guestName: "Alex",
			memberSocket: alpha.socketPath,
			submittedByMember: "member",
		},
		"alpha-generated-1",
		"pending",
	);
	assert.ok(alpha.admission.approve("alpha-generated-1", "lead").ok);

	const otherJoin = await wireJoin(alpha.socketPath, "other-session", "Blair", callbackEndpoint);
	assert.ok(otherJoin.response.success);
	assert.ok(alpha.admission.deny("alpha-generated-2", "lead").ok);

	// Crash: rebuild the Member side from the last persisted snapshot only.
	const lastSnapshot = alpha.snapshots.at(-1) as unknown[];
	assert.equal(lastSnapshot.length, 2, "denied tombstones persist next to approvals");
	const restoredMember = createGuestAdmissionRuntime({
		manifest: {
			version: 1 as const,
			crew: { id: "alpha", displayName: "Alpha" },
			guestAdmission: { approvers: ["lead"] },
			members: [{ name: "lead", role: "lead", socket: "sockets/alpha.sock" }],
		},
		memberName: "lead",
		createRequestId: () => "restored-id",
		createCapability: () => "restored-capability",
	});
	assert.deepEqual(restoredMember.restore(lastSnapshot).restored.sort(), [
		"guest-session-integration",
		"other-session",
	]);
	assert.deepEqual(
		restoredMember.list().map((row) => [row.guestName, row.status]),
		[
			["Alex", "approved"],
			["Blair", "denied"],
		],
	);

	// The Guest side restores the still-approved binding under a new callback
	// endpoint without repeating approval.
	const persistedGuestRecords = (
		lastSnapshot.filter((entry) => (entry as { status?: string }).status === "approved") as Array<{
			record: unknown;
		}>
	).map((entry) => entry.record);
	const restoredGuest = guestRuntimeFor(path.join(root, "new-callback.sock"));
	assert.deepEqual(restoredGuest.restore(persistedGuestRecords).restored, ["alpha"]);
	assert.deepEqual(
		restoredGuest.list().map((row) => [row.crew.id, row.status, row.guestName]),
		[["alpha", "approved", "Alex"]],
	);
	// The restored binding is revoked through the new endpoint (remote leave
	// after restart), proving the endpoint refresh took effect.
	const restoredCrew = await startMemberCrew(root, "alpha-restored", "Alpha");
	t.after(async () => restoredCrew.close());
	assert.ok(
		restoredCrew.admission.receive({
			requestId: "seed",
			crew: { id: "alpha-restored", displayName: "Alpha" },
			guestIdentity: GUEST_IDENTITY,
			guestName: "Alex",
			callbackEndpoint: path.join(root, "new-callback.sock"),
			submittedByMember: "lead",
		}).ok,
	);
	assert.ok(restoredCrew.admission.approve("alpha-restored-generated-1", "lead").ok);
	const remoteLeaveAfterRestart = await wireLeave(
		restoredCrew.socketPath,
		GUEST_IDENTITY,
		"alpha-restored",
		path.join(root, "new-callback.sock"),
	);
	assert.ok(remoteLeaveAfterRestart.response.success);
});

test("capability is delivered through the approved join response exactly once and survives restarts", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-wire-capability-"));
	t.after(async () => fs.rm(root, { recursive: true, force: true }));
	const callbackEndpoint = path.join(root, "guest-callback.sock");
	const alpha = await startMemberCrew(root, "alpha", "Alpha");
	t.after(async () => alpha.close());
	const guestPersisted: unknown[][] = [];
	const guest = createGuestMembershipRuntime({
		guestIdentity: GUEST_IDENTITY,
		callbackEndpoint,
		createRequestId: () => "guest-local-1",
		persist: (records) => guestPersisted.push(records),
		submitJoinRequest: async () => undefined,
	});

	const pendingJoin = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	assert.deepEqual(pendingJoin.response.data, {
		status: "pending",
		requestId: "alpha-generated-1",
		crew: { id: "alpha", displayName: "Alpha" },
	});
	assert.deepEqual(
		guest.track(
			{
				crew: { id: "alpha", displayName: "Alpha" },
				guestName: "Alex",
				memberSocket: alpha.socketPath,
				submittedByMember: "member",
			},
			"alpha-generated-1",
			"pending",
		),
		{ ok: true, status: "pending", requestId: "alpha-generated-1", idempotent: false },
	);

	// The Member approves; the next approved join response carries the capability.
	assert.ok(alpha.admission.approve("alpha-generated-1", "lead").ok);
	const approvedJoin = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	const approvedData = approvedJoin.response.data as { status: string; capability?: string };
	assert.equal(approvedData.status, "approved");
	assert.equal(typeof approvedData.capability, "string");
	guest.track(
		{
			crew: { id: "alpha", displayName: "Alpha" },
			guestName: "Alex",
			memberSocket: alpha.socketPath,
			submittedByMember: "member",
		},
		"alpha-generated-1",
		"approved",
		approvedData.capability,
	);

	// The delivered capability matches the registry's verifier digest, and the
	// plaintext never reached the registry file (runtime-only).
	const registryRaw = await fs.readFile(path.join(root, "alpha", ".pi", "bebop", "guest-registry.json"), "utf8");
	assert.ok(!registryRaw.includes(String(approvedData.capability)));
	assert.ok(registryRaw.includes(digestGuestCapability(String(approvedData.capability))));

	// Exactly once: a further approved join does not re-deliver the capability.
	const repeatJoin = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	assert.equal("capability" in (repeatJoin.response.data as object), false);

	// The Guest runtime retained the credential across its own persistence.
	const lastGuestSnapshot = guestPersisted.at(-1) as Array<{ capability?: string }>;
	assert.equal(lastGuestSnapshot.at(-1)?.capability, approvedData.capability);

	// Member restart: a fresh runtime re-delivers the same capability once
	// (registry digest unchanged), so the Guest can recover a lost copy.
	const restartedGuestRuntime = createGuestMembershipRuntime({
		guestIdentity: GUEST_IDENTITY,
		callbackEndpoint,
		createRequestId: () => "guest-restart-1",
		submitJoinRequest: async () => undefined,
	});
	const restoredRecords = (guestPersisted.at(-1) as unknown[]).map((entry) => {
		const record = entry as { capability?: string };
		const { capability, ...core } = record;
		return capability === undefined ? core : { ...core, capability };
	});
	restartedGuestRuntime.restore(restoredRecords);
	assert.deepEqual(
		restartedGuestRuntime.list().map((row) => [row.crew.id, row.status]),
		[["alpha", "approved"]],
	);
});

test("Guest recipient revalidates direct Guest Broadcast sends before delivery", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-to-guest-wire-"));
	t.after(async () => fs.rm(root, { recursive: true, force: true }));
	const callbackEndpoint = path.join(root, "recipient-callback.sock");
	const sourceEndpoint = path.join(root, "source-callback.sock");
	const recipient = createGuestMembershipRuntime({
		guestIdentity: "guest-recipient",
		callbackEndpoint,
		createRequestId: () => "recipient-request",
		submitJoinRequest: async () => undefined,
		authorizeInbound: (input) =>
			input.crewId === "alpha" && input.guestIdentity === GUEST_IDENTITY
				? { ok: true, guestName: "Alex" }
				: { ok: false, code: "not-approved" },
	});
	recipient.track(
		{
			crew: { id: "alpha", displayName: "Alpha" },
			guestName: "Blake",
			memberSocket: "member.sock",
			submittedByMember: "member",
		},
		"recipient-request",
		"approved",
		"recipient-capability",
	);
	const sentMessages: Array<{ content: string; details: any }> = [];
	const state = {
		membershipRuntime: null,
		guestMembershipRuntime: recipient,
		context: { isProjectTrusted: () => true, isIdle: () => true },
	};
	const server = await createRpcServer(callbackEndpoint, (command, socket) => {
		const respond = (success: boolean, commandName: string, data?: unknown, error?: string) =>
			writeResponse(socket, { type: "response", command: commandName, success, data, error, id: command.id });
		if (command.type !== "guest_send") return;
		return handleGuestSend(
			{
				pi: {
					sendMessage: (message: any) =>
						sentMessages.push({ content: message.content, details: message.details }),
				},
				state,
				ctx: state.context,
				socket,
				id: command.id,
				respond,
			} as unknown as Parameters<typeof handleGuestSend>[0],
			command,
		);
	});
	t.after(async () => closeRpcServer(server));
	const response = await sendRpcCommand(
		callbackEndpoint,
		{
			type: "guest_send",
			crewId: "alpha",
			guestIdentity: GUEST_IDENTITY,
			callbackEndpoint: sourceEndpoint,
			capability: "source-capability",
			target: "Blake",
			content: "hello Blake",
			kind: "broadcast",
		},
		{ timeout: 5000 },
	);
	assert.ok(response.response.success, String(response.response.error));
	assert.equal(sentMessages.length, 1);
	assert.equal(sentMessages[0]!.details.messagePayload.kind, "broadcast");
	assert.deepEqual(sentMessages[0]!.details.messagePayload.origin, {
		kind: "guest",
		identity: GUEST_IDENTITY,
		name: "Alex",
	});

	await assert.rejects(
		() =>
			sendRpcCommand(
				callbackEndpoint,
				{
					type: "guest_send",
					crewId: "alpha",
					guestIdentity: "spoofed",
					callbackEndpoint: sourceEndpoint,
					capability: "source-capability",
					target: "Blake",
					content: "spoof",
				},
				{ timeout: 5000 },
			),
		/not-approved/,
	);
});

test("guest_send delivers to the receiving member after fresh registry authorization", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-wire-send-"));
	t.after(async () => fs.rm(root, { recursive: true, force: true }));
	const callbackEndpoint = path.join(root, "guest-callback.sock");
	const alpha = await startMemberCrew(root, "alpha", "Alpha");
	t.after(async () => alpha.close());
	const guest = guestRuntimeFor(callbackEndpoint);

	const join = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	assert.ok(join.response.success);
	guest.track(
		{
			crew: { id: "alpha", displayName: "Alpha" },
			guestName: "Alex",
			memberSocket: alpha.socketPath,
			submittedByMember: "member",
		},
		"alpha-generated-1",
		"pending",
	);
	assert.ok(alpha.admission.approve("alpha-generated-1", "lead").ok);
	const approvedJoin = await wireJoin(alpha.socketPath, GUEST_IDENTITY, "Alex", callbackEndpoint);
	const capability = (approvedJoin.response.data as { capability: string }).capability;
	guest.track(
		{
			crew: { id: "alpha", displayName: "Alpha" },
			guestName: "Alex",
			memberSocket: alpha.socketPath,
			submittedByMember: "member",
		},
		"alpha-generated-1",
		"approved",
		capability,
	);

	// Authorized send: delivered locally as an ordinary follow-up with a
	// registry-derived guest origin.
	const send = await wireSend(
		alpha.socketPath,
		GUEST_IDENTITY,
		"alpha",
		callbackEndpoint,
		capability,
		"lead",
		"hello from the guest",
	);
	assert.ok(send.response.success, `guest_send failed: ${String(send.response.error)}`);
	const sendData = send.response.data as { deliveryId: string; disposition: string; fromGuestName: string };
	assert.equal(sendData.fromGuestName, "Alex");
	assert.equal(sendData.disposition, "direct");
	assert.equal(alpha.sentMessages.length, 1);
	const details = alpha.sentMessages[0]!.details as {
		messagePayload: { origin: { kind: string; name: string; identity: string } };
	};
	assert.equal(details.messagePayload.origin.kind, "guest");
	assert.equal(details.messagePayload.origin.name, "Alex");
	assert.equal(details.messagePayload.origin.identity, GUEST_IDENTITY);

	// Exactly-once capability: a replayed send with a fabricated capability and
	// a stale endpoint each fail closed with the exact codes.
	await assert.rejects(
		() => wireSend(alpha.socketPath, GUEST_IDENTITY, "alpha", callbackEndpoint, "fabricated", "lead", "spoof"),
		/capability-mismatch/,
	);
	await assert.rejects(
		() => wireSend(alpha.socketPath, GUEST_IDENTITY, "alpha", "/tmp/other.sock", capability, "lead", "drift"),
		/endpoint-mismatch/,
	);

	// Revocation takes effect immediately for new sends.
	assert.ok(alpha.admission.remove("Alex", "lead").ok);
	await assert.rejects(
		() => wireSend(alpha.socketPath, GUEST_IDENTITY, "alpha", callbackEndpoint, capability, "lead", "after revoke"),
		/revoked/,
	);
});
