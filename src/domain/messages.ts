export const SESSION_MESSAGE_TYPE = "bebop-session-message";

export interface ExtractedMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}
