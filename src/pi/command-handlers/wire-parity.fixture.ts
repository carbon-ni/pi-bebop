// Expected raw lines captured from the pre-extraction handleCommand at d302389.
export const wireParityFixtures = [
	{
		type: "status",
		command: { type: "status", id: "wire-status" },
		expected: '{"jsonrpc":"2.0","id":"wire-status","result":{"status":"online"}}\n',
	},
	{
		type: "get_message",
		command: { type: "get_message", id: "wire-get" },
		expected: '{"jsonrpc":"2.0","id":"wire-get","result":{"message":null}}\n',
	},
	{
		type: "clear",
		command: { type: "clear", id: "wire-clear" },
		expected: '{"jsonrpc":"2.0","id":"wire-clear","error":{"code":-32603,"message":"No entries in session"}}\n',
	},
	{
		type: "abort",
		command: { type: "abort", id: "wire-abort" },
		expected: '{"jsonrpc":"2.0","id":"wire-abort","result":{}}\n',
	},
	{
		type: "subscribe",
		command: { type: "subscribe", event: "turn_end", id: "wire-sub" },
		expected: '{"jsonrpc":"2.0","id":"wire-sub","result":{"subscriptionId":"wire-sub","event":"turn_end"}}\n',
	},
	{
		type: "send",
		command: { type: "send", payload: {}, id: "wire-send-invalid" },
		expected:
			'{"jsonrpc":"2.0","id":"wire-send-invalid","error":{"code":-32603,"message":"Invalid structured message payload"}}\n',
	},
	{
		type: "interrupt",
		command: { type: "interrupt", payload: {}, id: "wire-interrupt-invalid" },
		expected:
			'{"jsonrpc":"2.0","id":"wire-interrupt-invalid","error":{"code":-32603,"message":"invalid-payload"}}\n',
	},
	{
		type: "member_request",
		command: {
			type: "member_request",
			requestId: "r",
			payload: {
				content: 'wire \\\"value\\\"',
				instructions: [],
				origin: { kind: "crew", name: "peer", role: "dev" },
			},
			id: "wire-request",
		},
		expected: '{"jsonrpc":"2.0","id":"wire-request","error":{"code":-32603,"message":"not-joined"}}\n',
	},
	{
		type: "member_response",
		command: { type: "member_response", requestId: "r", message: "x", instructions: [], id: "wire-response" },
		expected: '{"jsonrpc":"2.0","id":"wire-response","error":{"code":-32603,"message":"not-joined"}}\n',
	},
	{
		type: "presence_hint",
		command: {
			type: "presence_hint",
			member: { identity: "i", name: "peer", role: "dev" },
			state: "online",
			instanceId: "i",
			id: "wire-presence",
		},
		expected: '{"jsonrpc":"2.0","id":"wire-presence","result":{"accepted":false}}\n',
	},
	{
		type: "member_status",
		command: { type: "member_status", member: "peer", id: "wire-ms" },
		expected: '{"jsonrpc":"2.0","id":"wire-ms","error":{"code":-32603,"message":"not-joined"}}\n',
	},
	{
		type: "member_status_target",
		command: { type: "member_status_target", target: "peer", id: "wire-mst" },
		expected: '{"jsonrpc":"2.0","id":"wire-mst","error":{"code":-32603,"message":"not-joined"}}\n',
	},
	{
		type: "member_follow_up",
		command: { type: "member_follow_up", target: "peer", message: "x", instructions: [], id: "wire-follow" },
		expected: '{"jsonrpc":"2.0","id":"wire-follow","error":{"code":-32603,"message":"not-joined"}}\n',
	},
	{
		type: "member_redirect",
		command: { type: "member_redirect", target: "peer", message: "x", instructions: [], id: "wire-redirect" },
		expected: '{"jsonrpc":"2.0","id":"wire-redirect","error":{"code":-32603,"message":"not-joined"}}\n',
	},
	{
		type: "member_inbox_send",
		command: { type: "member_inbox_send", target: "peer", message: "x", instructions: [], id: "wire-inbox" },
		expected:
			'{"jsonrpc":"2.0","id":"wire-inbox","error":{"code":-32603,"message":"not-joined","data":{"code":"not-joined"}}}\n',
	},
	{
		type: "crew_broadcast",
		command: { type: "crew_broadcast", message: "x", instructions: [], id: "wire-broadcast" },
		expected:
			'{"jsonrpc":"2.0","id":"wire-broadcast","error":{"code":-32603,"message":"not-joined","data":{"code":"not-joined"}}}\n',
	},
	{
		type: "member_idle_wait",
		command: { type: "member_idle_wait", member: "peer", id: "wire-wait" },
		expected: '{"jsonrpc":"2.0","id":"wire-wait","error":{"code":-32603,"message":"not-joined"}}\n',
	},
	{
		type: "member_interrupt",
		command: { type: "member_interrupt", target: "peer", message: "x", instructions: [], id: "wire-mi" },
		expected: '{"jsonrpc":"2.0","id":"wire-mi","error":{"code":-32603,"message":"not-joined"}}\n',
	},
] as const;
