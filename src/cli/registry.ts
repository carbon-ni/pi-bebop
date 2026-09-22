import path from "node:path";
import { Command } from "commander";
import { buildAskCommand, readAskCommand, runAskCommand, type AskCliOptions } from "./commands/ask.ts";
import { buildCrewInitCommand, readCrewInitCommand } from "./commands/crew-init.ts";
import { runCrewInitCommand } from "./commands/crew-init-handler.ts";
import type { CrewInitCliOptions } from "./support/arguments.ts";
import {
	buildGuestJoinCommand,
	buildGuestLeaveCommand,
	buildGuestMessageCommand,
	readGuestJoinCommand,
	readGuestLeaveCommand,
	readGuestMessageCommand,
	runGuestJoinCommand,
	runGuestLeaveCommand,
	runGuestMessageCommand,
	type GuestJoinCliOptions,
	type GuestLeaveCliOptions,
	type GuestMessageCliOptions,
} from "./commands/guest.ts";
import {
	buildCrewListCommand,
	readCrewListCommand,
	runCrewListCommand,
	type CrewListCliOptions,
} from "./commands/crew-list.ts";
import {
	buildCrewSessionAddCommand,
	buildCrewSessionCaptureCommand,
	buildCrewSessionListCommand,
	buildCrewSessionResolveCommand,
	buildCrewSessionShowCommand,
	readCrewSessionAddCommand,
	readCrewSessionCaptureCommand,
	readCrewSessionListCommand,
	readCrewSessionResolveCommand,
	readCrewSessionShowCommand,
	runCrewSessionAddCommand,
	runCrewSessionCaptureCommand,
	runCrewSessionListCommand,
	runCrewSessionResolveCommand,
	runCrewSessionShowCommand,
	type CrewSessionAddCliOptions,
	type CrewSessionCaptureCliOptions,
	type CrewSessionListCliOptions,
	type CrewSessionResolveCliOptions,
	type CrewSessionShowCliOptions,
} from "./commands/crew-session.ts";
import {
	buildCrewRolesCommand,
	readCrewRolesCommand,
	runCrewRolesCommand,
	type CrewRolesCliOptions,
} from "./commands/crew-roles.ts";
import {
	buildMemberStatusCommand,
	readMemberStatusCommand,
	runMemberStatusCommand,
	type MemberStatusCliOptions,
} from "./commands/member-status.ts";
import {
	buildMemberIdleWaitCommand,
	readMemberIdleWaitCommand,
	runMemberIdleWaitCommand,
	type MemberIdleWaitCliOptions,
} from "./commands/member-idle-wait.ts";
import {
	buildSessionListCommand,
	readSessionListCommand,
	runSessionListCommand,
	type SessionListCliOptions,
} from "./commands/session-list.ts";
import {
	buildMemberMessageCommand,
	readMemberMessageCommand,
	runMemberMessageCommand,
	type MemberMessageCliOptions,
} from "./commands/member-message.ts";
import {
	buildDurableMessageCommand,
	readDurableMessageCommand,
	runDurableMessageCommand,
	type DurableMessageCliOptions,
} from "./commands/durable-message.ts";
import {
	buildMemberInterruptCommand,
	readMemberInterruptCommand,
	runMemberInterruptCommand,
	type MemberInterruptCliOptions,
} from "./commands/member-interrupt.ts";
import {
	buildMemberRequestSendCommand,
	buildMemberRequestListCommand,
	buildMemberRequestWaitCommand,
	buildMemberRequestRespondCommand,
	readMemberRequestSendCommand,
	readMemberRequestListCommand,
	readMemberRequestWaitCommand,
	readMemberRequestRespondCommand,
	runMemberRequestCommand,
	type MemberRequestCliOptions,
} from "./commands/member-request.ts";
import {
	buildRoleSessionResumeCommand,
	readRoleSessionResumeCommand,
	runRoleSessionResumeCommand,
	type RoleSessionResumeCliOptions,
} from "./commands/role-session-resume.ts";
import type { CliContext } from "./support/context.ts";
import type { CliOutcome } from "./support/output.ts";

/**
 * TASK-0209: the single CLI composition point. Every command is ONE leaf
 * module owning its Commander grammar (`build`), its semantic reader
 * (`read`), and its handler adapter (`run`). Command discovery, help, and
 * syntax errors are delegated to Commander; leaf modules never duplicate
 * grammar, prose help, or error rewording.
 */

export interface CliLeaf {
	/** Stable leaf id; also the dispatch key. */
	readonly id: string;
	/** Command vocabulary words, e.g. ["crew", "init"]. */
	readonly names: readonly string[];
	/** Commander schema: the sole source of names, arguments, options, and descriptions. */
	readonly build: () => Command;
	/** Reads validated options from the Commander-parsed command (semantic validation only). */
	readonly read: (command: Command, cwd: string) => unknown;
	/** Handler adapter — owns this command's business logic. */
	readonly run: (options: unknown, context: CliContext) => Promise<CliOutcome>;
}

export interface CliCommandHooks {
	/** Runs after root creation and before leaves attach, so descendants inherit stream configuration. */
	readonly onRoot?: (command: Command) => void;
	readonly onLeaf?: (command: Command, leaf: CliLeaf) => void;
}

export interface CliRegistry {
	/** Ordered leaf composition — the only place command wiring grows. */
	readonly leaves: readonly CliLeaf[];
	readonly leafById: (id: string) => CliLeaf;
	/** Command tree derived from the ordered leaves (groups + leaves). */
	readonly root: () => Command;
}

const GROUP_DESCRIPTIONS: Record<string, string> = {
	crew: "Crew commands",
	guest: "Guest commands",
	member: "Member commands",
	session: "Session commands",
};

function findOrCreate(parent: Command, name: string, description: string | undefined): Command {
	const existing = parent.commands.find((candidate) => candidate.name() === name);
	if (existing) return existing;
	const child = new Command(name);
	if (description !== undefined) child.description(description);
	// Commands attached via addCommand do not inherit parent settings automatically
	// (unlike the .command() factory); copy them so stream capture, exitOverride
	// behavior, help-after-error, and suggestions apply at every tree level.
	child.copyInheritedSettings(parent);
	parent.addCommand(child);
	return child;
}

/** Builds the declarative root tree from the ordered leaves (no hardcoded vocabulary). */
export function buildRootCommand(leaves: readonly CliLeaf[], hooks: CliCommandHooks = {}): Command {
	const root = new Command("bebop").description("Pi Bebop crew coordination CLI");
	hooks.onRoot?.(root);
	for (const leaf of leaves) {
		let parent = root;
		for (const word of leaf.names.slice(0, -1)) parent = findOrCreate(parent, word, GROUP_DESCRIPTIONS[word]);
		const command = leaf.build();
		command.copyInheritedSettings(parent);
		hooks.onLeaf?.(command, leaf);
		parent.addCommand(command);
	}
	return root;
}

/**
 * Composes a registry from an ordered leaf list. Pure and stateless: every
 * call builds fresh lookups, so composing the same leaves twice yields
 * independent, equivalent registries.
 */
export function composeRegistry(leaves: readonly CliLeaf[]): CliRegistry {
	const byId = new Map(leaves.map((leaf) => [leaf.id, leaf] as const));
	return {
		leaves,
		leafById: (id) => {
			const leaf = byId.get(id);
			if (leaf === undefined) throw new Error(`Unknown command '${id}'`);
			return leaf;
		},
		root: () => buildRootCommand(leaves),
	};
}

const askLeaf: CliLeaf = {
	id: "ask",
	names: ["ask"],
	build: () => buildAskCommand(),
	read: (command) => readAskCommand(command),
	run: (options, context) => runAskCommand(options as AskCliOptions, context),
};

const crewInitLeaf: CliLeaf = {
	id: "crew-init",
	names: ["crew", "init"],
	build: () => buildCrewInitCommand(),
	read: (command, cwd) => {
		const options = readCrewInitCommand(command);
		return {
			command: "crew-init",
			...(options.project === undefined ? {} : { project: path.resolve(cwd, options.project) }),
			format: options.format,
		};
	},
	run: (options, context) => runCrewInitCommand(options as CrewInitCliOptions, context.cwd),
};

const crewListLeaf: CliLeaf = {
	id: "crew-list",
	names: ["crew", "list"],
	build: () => buildCrewListCommand(),
	read: (command) => readCrewListCommand(command),
	run: (options, context) => runCrewListCommand(options as CrewListCliOptions, context),
};

/** Crew Session capture/add/list/show/resolve leaves under `session ...`. */
const sessionCaptureLeaf: CliLeaf = {
	id: "session-capture",
	names: ["session", "capture"],
	build: () => buildCrewSessionCaptureCommand(),
	read: (command) => readCrewSessionCaptureCommand(command),
	run: (options, context) => runCrewSessionCaptureCommand(options as CrewSessionCaptureCliOptions, context),
};
const sessionAddLeaf: CliLeaf = {
	id: "session-add",
	names: ["session", "add"],
	build: () => buildCrewSessionAddCommand(),
	read: (command) => readCrewSessionAddCommand(command),
	run: (options, context) => runCrewSessionAddCommand(options as CrewSessionAddCliOptions, context),
};
const sessionListLeaf: CliLeaf = {
	id: "session-list",
	names: ["session", "list"],
	build: () => buildCrewSessionListCommand(),
	read: (command) => readCrewSessionListCommand(command),
	run: (options, context) => runCrewSessionListCommand(options as CrewSessionListCliOptions, context),
};
const sessionShowLeaf: CliLeaf = {
	id: "session-show",
	names: ["session", "show"],
	build: () => buildCrewSessionShowCommand(),
	read: (command) => readCrewSessionShowCommand(command),
	run: (options, context) => runCrewSessionShowCommand(options as CrewSessionShowCliOptions, context),
};
const sessionResolveLeaf: CliLeaf = {
	id: "session-resolve",
	names: ["session", "resolve"],
	build: () => buildCrewSessionResolveCommand(),
	read: (command) => readCrewSessionResolveCommand(command),
	run: (options, context) => runCrewSessionResolveCommand(options as CrewSessionResolveCliOptions, context),
};

/** Current-Crew role-scoped Pi Session picker. */
const sessionResumeLeaf: CliLeaf = {
	id: "session-resume",
	names: ["session", "resume"],
	build: () => buildRoleSessionResumeCommand(),
	read: (command) => readRoleSessionResumeCommand(command),
	run: (options, context) => runRoleSessionResumeCommand(options as RoleSessionResumeCliOptions, context),
};

const crewRolesLeaf: CliLeaf = {
	id: "crew-roles",
	names: ["crew", "roles"],
	build: () => buildCrewRolesCommand(),
	read: (command) => readCrewRolesCommand(command),
	run: (options, context) => runCrewRolesCommand(options as CrewRolesCliOptions, context),
};

/** Correlated Member Request lifecycle leaves. */
const memberRequestSendLeaf: CliLeaf = {
	id: "member-request-send",
	names: ["member", "request", "send"],
	build: () => buildMemberRequestSendCommand(),
	read: (command) => readMemberRequestSendCommand(command),
	run: (options, context) => runMemberRequestCommand(options as MemberRequestCliOptions, context),
};
const memberRequestListLeaf: CliLeaf = {
	id: "member-request-list",
	names: ["member", "request", "list"],
	build: () => buildMemberRequestListCommand(),
	read: (command) => readMemberRequestListCommand(command),
	run: (options, context) => runMemberRequestCommand(options as MemberRequestCliOptions, context),
};
const memberRequestWaitLeaf: CliLeaf = {
	id: "member-request-wait",
	names: ["member", "request", "wait"],
	build: () => buildMemberRequestWaitCommand(),
	read: (command) => readMemberRequestWaitCommand(command),
	run: (options, context) => runMemberRequestCommand(options as MemberRequestCliOptions, context),
};
const memberRequestRespondLeaf: CliLeaf = {
	id: "member-request-respond",
	names: ["member", "request", "respond"],
	build: () => buildMemberRequestRespondCommand(),
	read: (command) => readMemberRequestRespondCommand(command),
	run: (options, context) => runMemberRequestCommand(options as MemberRequestCliOptions, context),
};

const memberStatusLeaf: CliLeaf = {
	id: "member-status",
	names: ["member", "status"],
	build: () => buildMemberStatusCommand(),
	read: (command) => readMemberStatusCommand(command),
	run: (options, context) => runMemberStatusCommand(options as MemberStatusCliOptions, context),
};

const memberIdleWaitLeaf: CliLeaf = {
	id: "member-idle-wait",
	names: ["member", "wait-idle"],
	build: () => buildMemberIdleWaitCommand(),
	read: (command) => readMemberIdleWaitCommand(command),
	run: (options, context) => runMemberIdleWaitCommand(options as MemberIdleWaitCliOptions, context),
};

/** Live Pi Session discovery. */
const sessionLiveLeaf: CliLeaf = {
	id: "session-live",
	names: ["session", "live"],
	build: () => buildSessionListCommand(),
	read: (command) => readSessionListCommand(command),
	run: (options, context) => runSessionListCommand(options as SessionListCliOptions, context),
};

const memberFollowUpLeaf: CliLeaf = {
	id: "member-follow-up",
	names: ["member", "follow-up"],
	build: () => buildMemberMessageCommand("follow_up"),
	read: (command) => readMemberMessageCommand(command, "follow_up"),
	run: (options, context) => runMemberMessageCommand(options as MemberMessageCliOptions, context),
};

const memberRedirectLeaf: CliLeaf = {
	id: "member-redirect",
	names: ["member", "redirect"],
	build: () => buildMemberMessageCommand("redirect"),
	read: (command) => readMemberMessageCommand(command, "redirect"),
	run: (options, context) => runMemberMessageCommand(options as MemberMessageCliOptions, context),
};

/** Durable Inbox leaf. */
const memberInboxSendLeaf: CliLeaf = {
	id: "member-inbox-send",
	names: ["member", "inbox", "send"],
	build: () => buildDurableMessageCommand("inbox"),
	read: (command) => readDurableMessageCommand(command, "inbox"),
	run: (options, context) => runDurableMessageCommand(options as DurableMessageCliOptions, context),
};

/** Hard recovery interrupt leaf. */
const memberInterruptLeaf: CliLeaf = {
	id: "member-interrupt",
	names: ["member", "interrupt"],
	build: () => buildMemberInterruptCommand(),
	read: (command) => readMemberInterruptCommand(command),
	run: (options, context) => runMemberInterruptCommand(options as MemberInterruptCliOptions, context),
};

/** Durable fan-out leaf. */
const crewBroadcastLeaf: CliLeaf = {
	id: "crew-broadcast",
	names: ["crew", "broadcast"],
	build: () => buildDurableMessageCommand("broadcast"),
	read: (command) => readDurableMessageCommand(command, "broadcast"),
	run: (options, context) => runDurableMessageCommand(options as DurableMessageCliOptions, context),
};

const guestJoinLeaf: CliLeaf = {
	id: "guest-join",
	names: ["guest", "join"],
	build: () => buildGuestJoinCommand(),
	read: (command) => readGuestJoinCommand(command),
	run: (options, context) => runGuestJoinCommand(options as GuestJoinCliOptions, context),
};

const guestLeaveLeaf: CliLeaf = {
	id: "guest-leave",
	names: ["guest", "leave"],
	build: () => buildGuestLeaveCommand(),
	read: (command) => readGuestLeaveCommand(command),
	run: (options, context) => runGuestLeaveCommand(options as GuestLeaveCliOptions, context),
};

const guestSendLeaf: CliLeaf = {
	id: "guest-send",
	names: ["guest", "send"],
	build: () => buildGuestMessageCommand("send"),
	read: (command) => readGuestMessageCommand(command, "send"),
	run: (options, context) => runGuestMessageCommand(options as GuestMessageCliOptions, context),
};

const guestBroadcastLeaf: CliLeaf = {
	id: "guest-broadcast",
	names: ["guest", "broadcast"],
	build: () => buildGuestMessageCommand("broadcast"),
	read: (command) => readGuestMessageCommand(command, "broadcast"),
	run: (options, context) => runGuestMessageCommand(options as GuestMessageCliOptions, context),
};

export function createCliRegistry(): CliRegistry {
	return composeRegistry([
		askLeaf,
		crewInitLeaf,
		crewListLeaf,
		sessionCaptureLeaf,
		sessionAddLeaf,
		sessionListLeaf,
		sessionShowLeaf,
		sessionResolveLeaf,
		sessionResumeLeaf,
		crewRolesLeaf,
		memberStatusLeaf,
		memberIdleWaitLeaf,
		sessionLiveLeaf,
		memberFollowUpLeaf,
		memberRedirectLeaf,
		memberRequestSendLeaf,
		memberRequestListLeaf,
		memberRequestWaitLeaf,
		memberRequestRespondLeaf,
		memberInterruptLeaf,
		memberInboxSendLeaf,
		crewBroadcastLeaf,
		guestJoinLeaf,
		guestLeaveLeaf,
		guestSendLeaf,
		guestBroadcastLeaf,
	]);
}
