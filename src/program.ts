import { Command, CommanderError } from "commander";
import {
  runAgentsCreate,
  runAgentsDelete,
  runAgentsList,
  runAgentsShow,
  runAgentsUpdate,
} from "./commands/agents.ts";
import { runBoxKeepalive, runBoxKeepaliveStatus, runBoxStatus, runBoxWake } from "./commands/box.ts";
import { runDaemonEnsure, runDaemonServe, runDaemonStatus } from "./commands/daemon.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runRecover } from "./commands/recover.ts";
import { runQuota } from "./commands/quota.ts";
import {
  runDesktopKeepAdd,
  runDesktopKeepRemove,
  runDesktopPruneDisable,
  runDesktopPruneEnable,
  runDesktopPruneRun,
  runDesktopStatus,
} from "./commands/desktop.ts";
import { runExec } from "./commands/exec.ts";
import { runEvents } from "./commands/events.ts";
import {
  runFsDownload,
  runFsList,
  runFsMkdir,
  runFsRead,
  runFsRemove,
  runFsStat,
  runFsUpload,
  runFsWrite,
} from "./commands/fs.ts";
import {
  runGroupMembersAdd,
  runGroupMembersList,
  runGroupMembersRemove,
  runGroupMembersSet,
  runGroupsCreate,
  runGroupsDelete,
  runGroupsList,
  runGroupsShow,
  runGroupsUpdate,
} from "./commands/groups.ts";
import { runHistorySearch, runHistoryTail, runHistoryThread } from "./commands/history.ts";
import { runJobsCancel, runJobsList, runJobsLogs, runJobsShow } from "./commands/jobs.ts";
import { runInit } from "./commands/init.ts";
import { runIsRunning } from "./commands/is.ts";
import { runMemoryList } from "./commands/memory.ts";
import {
  runProfileAdd,
  runProfileCapabilities,
  runProfileList,
  runProfileRemove,
  runProfileShow,
  runProfileUpdate,
  runProfileUse,
  type ProfileOptions,
} from "./commands/profile.ts";
import { runSend } from "./commands/send.ts";
import { resolveProfile } from "./config/profile.ts";
import type { CliDeps } from "./deps.ts";
import { CliError, usage } from "./errors.ts";
import { writeFailure } from "./output.ts";
import {
  GLOBAL_OPTIONS,
  LEAF_COMMANDS,
  START_HERE,
  TOP_LEVEL_COMMANDS,
  leafKey,
  type LeafCommand,
} from "./registry.ts";
import { runSkillsGet, runSkillsList } from "./skills.ts";

type CliOptions = ProfileOptions & {
  profile?: string;
  timeoutMs?: string;
  includeHidden?: boolean;
  full?: boolean;
  text?: string;
  expectKind?: string;
  nonce?: string;
  limit?: string;
  beforeSeq?: string;
  root?: string;
  content?: boolean;
  channels?: string;
  once?: boolean;
  includeMemoryContent?: boolean;
  local?: boolean;
  peer?: string;
  bootstrap?: boolean;
  admitHomeRead?: boolean;
  expectedSha256?: string;
  recursive?: boolean;
  yes?: boolean;
  socket?: string;
  name?: string;
  description?: string;
  instructions?: string;
  title?: string;
  avatarShape?: string;
  avatarColor?: string;
  notify?: string;
  hidden?: string;
  member?: string[];
  cwd?: string;
  env?: string[];
  runTimeoutMs?: string;
  output?: string;
  detach?: boolean;
  shell?: boolean;
  state?: string;
  offset?: string;
  limitBytes?: string;
  follow?: boolean;
  intervalMs?: string;
};

type LeafAction = (
  deps: CliDeps,
  args: Array<string | undefined>,
  options: CliOptions,
) => Promise<void>;

const FAMILY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  skills: "Bundled skills (version-matched)",
  profile: "Profile configuration and selection",
  daemon: "Local daemon lifecycle",
  agents: "Non-group Grok Bot agents",
  groups: "Product groups",
  "groups members": "Product group membership",
  history: "Search and read display transcript",
  memory: "Read agent Memory metadata",
  fs: "Governed cloud-computer files",
  exec: "Governed structured process execution",
  jobs: "Durable daemon Jobs",
  box: "Cursor Sandbox lifecycle",
  "box keepalive": "External Sandbox lease keeper",
  desktop: "Idle desktop fork status and prune",
  "desktop keep": "Persist Chrome keep protection on the box daemon",
  "desktop prune": "Plan, stop, or schedule idle desktop prune",
  is: "Read state projections",
};

function publicCommanderMessage(error: CommanderError): string {
  const text = error.message.replace(/^error: /i, "").trim();
  if (/bearer|authorization|token/i.test(text)) return "Invalid usage.";
  return text.length > 0 ? text : "Invalid usage.";
}

function unexpectedMessage(error: unknown): string {
  if (error instanceof Error) {
    if (/bearer|authorization|token/i.test(error.message)) return "Unexpected CLI failure.";
    return error.message;
  }
  return "Unexpected CLI failure.";
}

function actionBindings(): Readonly<Record<string, LeafAction>> {
  return {
    init: async (deps, args, options) => await runInit(deps, args[0], options),
    "skills list": async (deps, _args, options) => await runSkillsList(deps, options),
    "skills get": async (deps, args, options) => await runSkillsGet(deps, args[0] ?? "", options),
    "profile list": async (deps, _args, options) => await runProfileList(deps, options),
    "profile show": async (deps, args, options) => await runProfileShow(deps, args[0], options),
    "profile use": async (deps, args, options) => await runProfileUse(deps, args[0] ?? "", options),
    "profile add": async (deps, args, options) => await runProfileAdd(deps, args[0] ?? "", options),
    "profile update": async (deps, args, options) => await runProfileUpdate(deps, args[0] ?? "", options),
    "profile remove": async (deps, args, options) => await runProfileRemove(deps, args[0] ?? "", options),
    "profile capabilities": async (deps, args, options) =>
      await runProfileCapabilities(deps, args[0], options),
    "daemon serve": async (deps, _args, options) => await runDaemonServe(deps, options),
    "daemon ensure": async (deps, _args, options) => await runDaemonEnsure(deps, options),
    "daemon status": async (deps, _args, options) => await runDaemonStatus(deps, options),
    doctor: async (deps, _args, options) => await runDoctor(deps, options),
    recover: async (deps, _args, options) => await runRecover(deps, options),
    quota: async (deps, _args, options) => await runQuota(deps, options),
    "desktop status": async (deps, _args, options) => await runDesktopStatus(deps, options),
    "desktop keep add": async (deps, args, options) => await runDesktopKeepAdd(deps, args[0] ?? "", options),
    "desktop keep remove": async (deps, args, options) => await runDesktopKeepRemove(deps, args[0] ?? "", options),
    "desktop prune run": async (deps, _args, options) => await runDesktopPruneRun(deps, options),
    "desktop prune enable": async (deps, _args, options) => await runDesktopPruneEnable(deps, options),
    "desktop prune disable": async (deps, _args, options) => await runDesktopPruneDisable(deps, options),
    "box status": async (deps, _args, options) => await runBoxStatus(deps, options),
    "box wake": async (deps, _args, options) => await runBoxWake(deps, options),
    "box keepalive run": async (deps, _args, options) => await runBoxKeepalive(deps, options),
    "box keepalive status": async (deps, _args, options) => await runBoxKeepaliveStatus(deps, options),
    "agents list": async (deps, _args, options) => await runAgentsList(deps, options),
    "agents show": async (deps, args, options) => await runAgentsShow(deps, args[0] ?? "", options),
    "agents create": async (deps, _args, options) => await runAgentsCreate(deps, options),
    "agents update": async (deps, args, options) => await runAgentsUpdate(deps, args[0] ?? "", options),
    "agents delete": async (deps, args, options) => await runAgentsDelete(deps, args[0] ?? "", options),
    "groups list": async (deps, _args, options) => await runGroupsList(deps, options),
    "groups show": async (deps, args, options) => await runGroupsShow(deps, args[0] ?? "", options),
    "groups create": async (deps, _args, options) => await runGroupsCreate(deps, options),
    "groups update": async (deps, args, options) => await runGroupsUpdate(deps, args[0] ?? "", options),
    "groups delete": async (deps, args, options) => await runGroupsDelete(deps, args[0] ?? "", options),
    "groups members list": async (deps, args, options) =>
      await runGroupMembersList(deps, args[0] ?? "", options),
    "groups members add": async (deps, args, options) =>
      await runGroupMembersAdd(deps, args[0] ?? "", args[1] ?? "", options),
    "groups members remove": async (deps, args, options) =>
      await runGroupMembersRemove(deps, args[0] ?? "", args[1] ?? "", options),
    "groups members set": async (deps, args, options) =>
      await runGroupMembersSet(deps, args[0] ?? "", options),
    send: async (deps, args, options) => await runSend(deps, args[0] ?? "", options),
    "history search": async (deps, args, options) =>
      await runHistorySearch(deps, args[0] ?? "", options),
    "history tail": async (deps, args, options) => await runHistoryTail(deps, args[0] ?? "", options),
    "history thread": async (deps, args, options) =>
      await runHistoryThread(deps, args[0] ?? "", options),
    "memory list": async (deps, args, options) => await runMemoryList(deps, args[0] ?? "", options),
    "fs stat": async (deps, args, options) => await runFsStat(deps, args[0] ?? "", options),
    "fs list": async (deps, args, options) => await runFsList(deps, args[0] ?? "", options),
    "fs read": async (deps, args, options) => await runFsRead(deps, args[0] ?? "", options),
    "fs download": async (deps, args, options) =>
      await runFsDownload(deps, args[0] ?? "", args[1] ?? "", options),
    "fs write": async (deps, args, options) => await runFsWrite(deps, args[0] ?? "", options),
    "fs mkdir": async (deps, args, options) => await runFsMkdir(deps, args[0] ?? "", options),
    "fs upload": async (deps, args, options) =>
      await runFsUpload(deps, args[0] ?? "", args[1] ?? "", options),
    "fs remove": async (deps, args, options) => await runFsRemove(deps, args[0] ?? "", options),
    "exec run": async (deps, args, options) => await runExec(deps, args.filter((value): value is string => value !== undefined), options),
    "jobs list": async (deps, _args, options) => await runJobsList(deps, options),
    "jobs show": async (deps, args, options) => await runJobsShow(deps, args[0] ?? "", options),
    "jobs logs": async (deps, args, options) => await runJobsLogs(deps, args[0] ?? "", options),
    "jobs cancel": async (deps, args, options) => await runJobsCancel(deps, args[0] ?? "", options),
    events: async (deps, _args, options) => await runEvents(deps, options),
    "is running": async (deps, args, options) => await runIsRunning(deps, args[0] ?? "", options),
  };
}

function addLeaf(
  deps: CliDeps,
  program: Command,
  parents: Map<string, Command>,
  leaf: LeafCommand,
  action: LeafAction,
): void {
  let parent = program;
  for (let index = 0; index < leaf.path.length - 1; index += 1) {
    const path = leaf.path.slice(0, index + 1);
    const key = leafKey(path);
    let family = parents.get(key);
    if (!family) {
      const name = path[path.length - 1];
      if (!name) throw new Error(`Invalid registry path '${key}'.`);
      family = parent.command(name).description(FAMILY_DESCRIPTIONS[key] ?? key);
      family.action(() => {
        throw usage(`Missing subcommand. Try grokbox ${key} --help.`);
      });
      parents.set(key, family);
    }
    parent = family;
  }

  const name = leaf.path[leaf.path.length - 1];
  if (!name) throw new Error("Leaf command path is empty.");
  const command = parent.command(name).description(leaf.summary);
  for (const argument of leaf.arguments) command.argument(argument.syntax, argument.description);
  for (const option of leaf.options) {
    if (option.required) command.requiredOption(option.flags, option.description);
    else command.option(option.flags, option.description);
  }
  command.action(async (...values: unknown[]) => {
    const args = values
      .slice(0, leaf.arguments.length)
      .flatMap((value) => Array.isArray(value)
        ? value.map((entry) => String(entry))
        : [value === undefined ? undefined : String(value)]);
    const localOptions = (values[leaf.arguments.length] as CliOptions | undefined) ?? {};
    const globalOptions = program.opts<CliOptions>();
    if (globalOptions.profile !== undefined && leaf.profile === false) {
      throw usage(`grokbox ${leafKey(leaf.path)} does not accept --profile; use its positional name.`);
    }
    if (globalOptions.json && !leaf.options.some((option) => option.flags.includes("--json"))) {
      throw usage(`grokbox ${leafKey(leaf.path)} does not support --json.`);
    }
    if (globalOptions.table && !leaf.table) {
      throw usage(`grokbox ${leafKey(leaf.path)} does not support --table.`);
    }
    if (globalOptions.timeoutMs !== undefined && !leaf.timeout) {
      throw usage(`grokbox ${leafKey(leaf.path)} does not support --timeout-ms.`);
    }
    const options = { ...globalOptions, ...localOptions };
    let runtimeDeps = deps;
    if (leaf.profile !== false) {
      const profile = await resolveProfile(deps, options.profile);
      runtimeDeps = {
        ...deps,
        discoveryPath: profile.gateway_discovery,
        daemonSocket: profile.daemon_socket,
        daemonServerUrl: profile.server_url,
        daemonTokenRef: profile.daemon_token_ref,
        profileName: profile.name,
        sshHost: profile.ssh_host,
        sandboxAccessTokenRef: profile.sandbox?.access_token_ref,
        sandboxKeepaliveIntervalMs: profile.sandbox?.keepalive_interval_ms,
        quotaSource: profile.quota?.source,
        quotaAccessTokenRef: profile.quota?.access_token_ref,
        gatewayServerUrl: profile.gateway_url,
        gatewayTokenRef: profile.gateway_token_ref,
        gatewayHeadersRef: profile.gateway_headers_ref,
        transport: profile.transport,
      };
    }
    await action(runtimeDeps, args, options);
  });
}

export function createProgram(deps: CliDeps): Command {
  const program = new Command();
  program
    .name("grokbox")
    .description("Agent-first CLI and control plane for Grok Bot cloud computers.")
    .version(deps.cliVersion, "--version")
    .enablePositionalOptions()
    .helpCommand(false)
    .showSuggestionAfterError(false)
    .showHelpAfterError(false)
    .exitOverride()
    .addHelpText("before", `${START_HERE}\n`);

  for (const option of GLOBAL_OPTIONS) program.option(option.flags, option.description);
  program.configureOutput({
    writeOut: (chunk) => deps.stdout.write(chunk),
    writeErr: () => {
      // Usage failures are emitted as JSON by runCli.
    },
  });
  program.action(() => {
    throw usage("Missing command. Try grokbox --help or grokbox skills get core --full.");
  });

  const bindings = actionBindings();
  const parents = new Map<string, Command>();
  for (const leaf of LEAF_COMMANDS) {
    const key = leafKey(leaf.path);
    const action = bindings[key];
    if (!action) throw new Error(`No implementation binding for registry leaf '${key}'.`);
    addLeaf(deps, program, parents, leaf, action);
  }
  for (const key of Object.keys(bindings)) {
    if (!LEAF_COMMANDS.some((leaf) => leafKey(leaf.path) === key)) {
      throw new Error(`Implementation binding '${key}' has no registry leaf.`);
    }
  }

  const names = program.commands.map((command) => command.name());
  for (const expected of TOP_LEVEL_COMMANDS) {
    if (!names.includes(expected)) throw new Error(`Command registry missing ${expected}.`);
  }
  return program;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const program = createProgram(deps);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.exitCode === 0 ||
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return 0;
      }
      writeFailure(deps.stderr, usage(publicCommanderMessage(error)));
      return 2;
    }
    if (error instanceof CliError) {
      writeFailure(deps.stderr, error);
      return error.exitCode;
    }
    writeFailure(deps.stderr, new CliError("gateway_internal", unexpectedMessage(error)));
    return 15;
  }
}
