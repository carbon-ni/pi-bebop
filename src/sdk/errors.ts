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
	| "remote-rejected"
	| "malformed-response"
	| "timeout"
	| "aborted"
	| "transport-error"
	| "outcome-unknown";

export class BebopClientError extends Error {
	readonly code: BebopClientErrorCode;

	constructor(code: BebopClientErrorCode, message?: string) {
		super(message ?? defaultErrorMessage(code));
		this.name = "BebopClientError";
		this.code = code;
	}
}

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
			"remote-rejected": "Source rejected the operation",
			"malformed-response": "Source returned a malformed response",
			timeout: "Bebop operation timed out",
			aborted: "Bebop operation was aborted",
			"transport-error": "Bebop transport failed",
			"outcome-unknown": "The operation may have been accepted but its acknowledgement was lost",
		} as Record<BebopClientErrorCode, string>
	)[code];
}
