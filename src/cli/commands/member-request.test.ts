import test from "node:test";
import assert from "node:assert/strict";
import { RpcProtocolError } from "../../infra/rpc-client.ts";
import { MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS, MAX_MEMBER_REQUEST_TIMEOUT_SECONDS } from "../../domain/index.ts";
import { runMemberRequestCommand } from "./member-request.ts";

const sendArgs = [
	"Dev",
	"--message",
	"status?",
	"--response-grace",
	"30s",
	"--max-wait",
	"5m",
	"--instruction",
	"ordered",
];
