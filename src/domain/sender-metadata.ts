export interface SenderInfo {
	sessionId: string;
	sessionName?: string;
}

const SENDER_INFO_BLOCK_PATTERN = /<sender_info>[\s\S]*?<\/sender_info>/g;
const SENDER_INFO_TAG_PATTERN = /<\/?sender_info>/g;

export function appendSenderMetadata(message: string, senderInfo?: SenderInfo | null): string {
	const sessionId = senderInfo?.sessionId?.trim();
	if (!sessionId) return message;

	const senderInfoPayload = JSON.stringify({
		sessionId,
		sessionName: senderInfo.sessionName?.trim() || undefined,
	});
	const sanitizedMessage = message
		.replace(SENDER_INFO_BLOCK_PATTERN, "")
		.replace(SENDER_INFO_TAG_PATTERN, "")
		.trimEnd();

	return `${sanitizedMessage}\n\n<sender_info>${senderInfoPayload}</sender_info>`;
}
