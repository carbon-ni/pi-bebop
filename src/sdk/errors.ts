export type BebopClientErrorCode =
	| "invalid-input"
	| "source-required"
	| "invalid-session"
	| "unknown-session"
	| "offline-session"
	| "offline-member"
	| "route-lost"
	| "message-too-large"
	| "not-joined"
	| "untrusted"
	| "unknown-member"
	| "ambiguous-member"
	| "self-query"
	| "identity-mismatch"
	| "capacity-exceeded"
	| "remote-rejected"
	| "malformed-response"
	| "timeout"
	| "aborted"
	| "transport-error"
	| "outcome-unknown"
	| "ambiguous-role"
	| "self-send"
	| "invalid-payload"
	| "untrusted-project"
	| "inbox-full"
	| "inbox-untrusted-path"
	| "storage-unavailable"
	| "storage-failed"
	| "invalid-request-id"
	| "unknown-request"
	| "no-pending-request"
	| "no-pending-requests"
	| "already-waiting"
	| "outcome-consumed"
	| "response-expired"
	| "ambiguous-request"
	| "already-terminal"
	| "duplicate-request"
	| "invalid-timeout"
	| "invalid-max-wait";

function defaultErrorMessage(code: BebopClientErrorCode): string {
	return (
		{
			"invalid-input": "Invalid SDK input",
			"source-required": "A source session is required",
			"invalid-session": "Invalid source session",
			"unknown-session": "Source session was not found",
			"offline-session": "Source session is offline",
			"offline-member": "Crew member is offline",
			"route-lost": "The route to the Crew member was lost",
			"message-too-large": "Crew member's last message is too large",
			"not-joined": "Source session is not joined to a crew",
			untrusted: "Source project is not trusted",
			"unknown-member": "Crew member was not found",
			"ambiguous-member": "Crew member selector is ambiguous",
			"self-query": "Cannot query the source member",
			"identity-mismatch": "Member returned a different identity",
			"capacity-exceeded": "Member idle-wait capacity was exceeded",
			"remote-rejected": "Source rejected the operation",
			"malformed-response": "Source returned a malformed response",
			timeout: "Bebop operation timed out",
			aborted: "Bebop operation was aborted",
			"transport-error": "Bebop transport failed",
			"outcome-unknown": "The operation may have been accepted but its acknowledgement was lost",
			"ambiguous-role": "The Inbox target role is ambiguous",
			"self-send": "Cannot enqueue an Inbox item for the source member",
			"invalid-payload": "The Inbox payload is invalid",
			"untrusted-project": "The project is not trusted for Inbox storage",
			"inbox-full": "The member Inbox is full",
			"inbox-untrusted-path": "The Inbox storage path is not trusted",
			"storage-unavailable": "The member Inbox store is temporarily unavailable",
			"storage-failed": "The member Inbox store failed",
			"invalid-request-id": "The Request ID is invalid",
			"unknown-request": "The Request ID is unknown",
			"no-pending-request": "No pending Member Request is available",
			"no-pending-requests": "No pending Member Requests are available",
			"already-waiting": "Another wait is already active",
			"outcome-consumed": "The Request outcome was already consumed",
			"response-expired": "The Request response window expired",
			"ambiguous-request": "More than one inbound Request matches",
			"already-terminal": "The Request is already terminal",
			"duplicate-request": "The Request ID is already in use",
			"invalid-timeout": "The Request grace timeout is invalid",
			"invalid-max-wait": "The Request max-wait timeout is invalid",
		} as Record<BebopClientErrorCode, string>
	)[code];
}

export class BebopClientError extends Error {
	readonly code: BebopClientErrorCode;

	constructor(code: BebopClientErrorCode, message?: string) {
		super(message ?? defaultErrorMessage(code));
		this.name = "BebopClientError";
		this.code = code;
	}
}
