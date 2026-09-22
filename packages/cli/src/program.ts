import { BoxRuntimeError } from "@grokbox/box-runtime/runtime";
import { ConfigError } from "@grokbox/runtime-kernel/config";
import { CONFIG_COMMANDS } from "./config-registry.ts";
import { runConfigCommand, type ConfigCommandOptions } from "./commands/config.ts";
import { Command, CommanderError } from "commander";
import {
  runAgentsCreate,
  runAgentsDelete,
  runAgentsList,
  runAgentsShow,
  runAgentsTitle,
  runAgentsUpdate,
} from "./commands/agents.ts";
import { runBoxKeepalive, runBoxKeepaliveStatus, runBoxStatus, runBoxWake } from "./commands/box.ts";
import { runDaemonEnsure, runDaemonServe, runDaemonStatus } from "./commands/daemon.ts";
import { runDoctor } from "./commands/doctor.ts";
import {
  runHostReserved,
  runHostRestart,
  runHostStart,
  runHostStop,
  runOperatorOff,
  runOperatorOn,
  runOperatorUpgrade,
} from "./commands/operator.ts";
import { runRecover } from "./commands/recover.ts";
import { runQuota } from "./commands/quota.ts";
import { runAgentsOwnership } from "./commands/ownership.ts";
import { runRuntimeServicesCli } from "./commands/runtime-services.ts";
import { runRuntimeMonitor } from "./commands/monitor.ts";
import { runExportAgent } from "./commands/export.ts";
import {
  runTemplateDelete,
  runTemplateImport,
  runTemplatePack,
  runTemplatePublish,
  runTemplateShow,
  runTemplateStage,
  runTemplateVisibility,
} from "./commands/template.ts";
import { runEvents } from "./commands/events.ts";
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
import { runAlerts, runSendOutcome, runRuntimeIncident } from "./commands/outcome.ts";
import { runGroupProgress } from "./commands/group-progress.ts";
import { runAlertTrace } from "./commands/alert-trace.ts";
import { runInit } from "./commands/init.ts";
import { runIsRunning } from "./commands/is.ts";
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
import { ManagementClientError } from "@grokbox/client";
import { MANAGEMENT_COMMANDS } from "./management-registry.ts";
import { runManagementCommand, writeManagementFailure, type ManagementCommandOptions } from "./commands/management-api.ts";
import { runAgentDuplicate, runAgentOperation } from "./commands/agent-duplicate.ts";
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
import {
  runRuntimeActivate,
  runRuntimeContracts,
  runRuntimeDeactivate,
  runRuntimeLog,
  runRuntimeModeld,
  runRuntimeModeldStatus,
  runRuntimeModeldReplace,
  runRuntimeModelsCheck,
  runRuntimeModelsPersistKey,
  runRuntimeProfileAnalyze,
  runRuntimeProfileObserve,
  runRuntimeProfilePropose,
  runRuntimeProfilePrune,
  runRuntimeProfileReplay,
  runRuntimeProfileStatus,
  runRuntimeProfileWatch,
  runRuntimeProfileWrite,
  runRuntimeReAdopt,
  runRuntimeOperationRecovery,
  runRuntimeStart,
  runRuntimeStatus,
  runRuntimeWatchdog,
} from "./commands/runtime.ts";
import { runSkillsGet, runSkillsList } from "./skills.ts";

type CliOptions = ProfileOptions & ConfigCommandOptions & ManagementCommandOptions & {
  agent?: string;
  requestId?: string;
  stepId?: string;
  waitFor?: string;
  agents?: string;
  after?: string;
  expectedRevision?: string;
  expectEpoch?: string;
  untilMs?: string;
  profile?: string;
  timeoutMs?: string;
  includeHidden?: boolean;
  ownership?: boolean;
  dryRun?: boolean;
  revert?: boolean;
  full?: boolean;
  text?: string;
  expectKind?: string;
  nonce?: string;
  limit?: string;
  beforeSeq?: string;
  root?: string;
  content?: boolean;
  out?: string;
  agentData?: string;
  includeRelatedWorkflows?: boolean;
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
  force?: boolean;
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
  source?: string;
  intervalMs?: string;
  mode?: string;
  for?: string;
  default?: boolean;
  effort?: string;
  from?: string;
  rev?: string;
  visibility?: string;
  fromPi?: string;
  confirm?: boolean;
  plan?: string;
  sha?: string;
  all?: boolean;
  against?: string;
  allowUnretained?: boolean;
  sliceReview?: string | string[];
  capability?: string;
  expectedReviewedSha?: string;
};

type LeafAction = (
  deps: CliDeps,
  args: Array<string | undefined>,
  options: CliOptions,
) => Promise<void>;

const FAMILY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  skills: "Version-matched bundled skills (prefer skills get grokbox)",
  profile: "Profile configuration and selection",
  config: "Unified configuration, validated edits and explicit one-way migration",
  daemon: "Local daemon lifecycle",
  agents: "Non-group Grok Bot agents",
  groups: "Product groups",
  "groups members": "Product group membership",
  history: "Search and read display transcript",
  memory: "Read agent Memory metadata",
  export: "Offline local Bot export",
  exec: "Governed structured process execution",
  jobs: "Durable daemon Jobs",
  box: "Cursor Sandbox lifecycle",
  "box keepalive": "External Sandbox lease keeper",
  host: "Custom-model Host channel",
  is: "Read state projections",
  runtime: "Box-local model runtime",
  "runtime monitor": "Local observation history and incidents, not execution authority",
  "runtime profile": "Offline reviewed PatchProfile authoring",
  "runtime watchdog": "Box-local desired-state Host coordinator",
  "runtime modeld": "Box-local model daemon",
  "agents title": "App title trailer show, hide, and sync",
  models: "Assign a custom model to one Bot",
  template: "Official Grok Bot templates",
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
    ...Object.fromEntries(MANAGEMENT_COMMANDS.map(leaf => [leafKey(leaf.path), async (deps: CliDeps, args: Array<string | undefined>, options: CliOptions) => runManagementCommand(deps, leafKey(leaf.path), args, options)])),
    ...Object.fromEntries(CONFIG_COMMANDS.map((leaf) => [leafKey(leaf.path), async (deps: CliDeps, args: Array<string | undefined>, options: CliOptions) => await runConfigCommand(deps, leaf.path[1]!, args, options)])),
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
    on: async (deps, _args, options) => await runOperatorOn(deps, options),
    off: async (deps, _args, options) => await runOperatorOff(deps, options),
    upgrade: async (deps, _args, options) => await runOperatorUpgrade(deps, options),
    "host start": async (deps, _args, options) => await runHostStart(deps, options),
    "host stop": async (deps, _args, options) => await runHostStop(deps, options),
    "host restart": async (deps, _args, options) => await runHostRestart(deps, options),
    "host status": async (deps) => await runHostReserved(deps, "status"),
    "host realign": async (deps) => await runHostReserved(deps, "realign"),
    "host logs": async (deps) => await runHostReserved(deps, "logs"),
    recover: async (deps, _args, options) => await runRecover(deps, options),
    quota: async (deps, _args, options) => await runQuota(deps, options),
    "box status": async (deps, _args, options) => await runBoxStatus(deps, options),
    "box wake": async (deps, _args, options) => await runBoxWake(deps, options),
    "box keepalive run": async (deps, _args, options) => await runBoxKeepalive(deps, options),
    "box keepalive status": async (deps, _args, options) => await runBoxKeepaliveStatus(deps, options),
    "agents list": async (deps, _args, options) => await runAgentsList(deps, options),
    "agents show": async (deps, args, options) => await runAgentsShow(deps, args[0] ?? "", options),
    "agents ownership": async (deps, args, options) => await runAgentsOwnership(deps, args.filter((arg): arg is string => arg !== undefined), options),
    "agents duplicate": async (deps, args, options) => await runAgentDuplicate(deps, args[0] ?? "", options),
    "agents operations show": async (deps, args, options) => await runAgentOperation(deps, args[0] ?? "", options),
    "agents create": async (deps, _args, options) => await runAgentsCreate(deps, options),
    "agents update": async (deps, args, options) => await runAgentsUpdate(deps, args[0] ?? "", options),
    "agents delete": async (deps, args, options) => await runAgentsDelete(deps, args[0] ?? "", options),
    "agents title show": async (deps, args, options) => await runAgentsTitle(deps, "show", args.filter((arg): arg is string => arg !== undefined), options),
    "agents title hide": async (deps, args, options) => await runAgentsTitle(deps, "hide", args.filter((arg): arg is string => arg !== undefined), options),
    "agents title sync": async (deps, args, options) => await runAgentsTitle(deps, "sync", args.filter((arg): arg is string => arg !== undefined), options),
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
    "template pack": async (deps, args, options) => await runTemplatePack(deps, args[0] ?? "", options),
    "template stage": async (deps, args, options) => await runTemplateStage(deps, args[0] ?? "", options),
    "template publish": async (deps, args, options) => await runTemplatePublish(deps, args[0] ?? "", options),
    "template show": async (deps, args, options) => await runTemplateShow(deps, args[0] ?? "", options),
    "template visibility": async (deps, args, options) => await runTemplateVisibility(deps, args[0] ?? "", options),
    "template delete": async (deps, args, options) => await runTemplateDelete(deps, args[0] ?? "", options),
    "template import": async (deps, args, options) => await runTemplateImport(deps, args[0] ?? "", options),
    send: async (deps, args, options) => await runSend(deps, args[0] ?? "", options),
    "history search": async (deps, args, options) =>
      await runHistorySearch(deps, args[0] ?? "", options),
    "history tail": async (deps, args, options) => await runHistoryTail(deps, args[0] ?? "", options),
    "alerts list": async (deps, _args, options) => await runAlerts(deps, options),
    "alerts trace": async (deps, args, options) => await runAlertTrace(deps, args[0] ?? "", options),
    "history outcome": async (deps, args, options) => await runSendOutcome(deps, args[0] ?? "", options),
    "history thread": async (deps, args, options) =>
      await runHistoryThread(deps, args[0] ?? "", options),
    "export agent": async (deps, args, options) => await runExportAgent(deps, args[0] ?? "", options),
    events: async (deps, _args, options) => await runEvents(deps, options),
    "is running": async (deps, args, options) => await runIsRunning(deps, args[0] ?? "", options),
    "runtime status": async (deps) => await runRuntimeStatus(deps),
    "runtime storage status": async (deps,args,options) => await runRuntimeMonitor(deps,"storage-status",args,options),
    "runtime services install": async (deps, _args, options) => await runRuntimeServicesCli(deps, "install", options),
    "runtime services status": async (deps, _args, options) => await runRuntimeServicesCli(deps, "status", options),
    "runtime services uninstall": async (deps, _args, options) => await runRuntimeServicesCli(deps, "uninstall", options),
    "runtime monitor install": async (deps,args,options) => await runRuntimeMonitor(deps,"install",args,options),
    "runtime monitor init": async (deps,args,options) => await runRuntimeMonitor(deps,"init",args,options),
    "runtime monitor run": async (deps,args,options) => await runRuntimeMonitor(deps,"run",args,options),
    "runtime monitor snapshot": async (deps,args,options) => await runRuntimeMonitor(deps,"snapshot",args,options),
    "runtime monitor events": async (deps,args,options) => await runRuntimeMonitor(deps,"events",args,options),
    "runtime monitor incidents": async (deps,args,options) => await runRuntimeMonitor(deps,"incidents",args,options),
    "runtime monitor incident": async (deps,args,options) => await runRuntimeMonitor(deps,"incident",args,options),
    "runtime monitor capture": async (deps,args,options) => await runRuntimeMonitor(deps,"capture",args,options),
    "runtime monitor evidence lease": async (deps,args,options) => await runRuntimeMonitor(deps,"lease",args,options),
    "runtime start": async (deps, _args, options) => await runRuntimeStart(deps, options.mode),
    "runtime activate": async (deps, _args, options) => await runRuntimeActivate(deps, options.mode),
    "runtime deactivate": async (deps) => await runRuntimeDeactivate(deps),
    "runtime log": async (deps, _args, options) => await runRuntimeLog(deps, options.follow, options.source),
    "runtime incident": async (deps, args, options) => await runRuntimeIncident(deps, args[0] ?? "", options),
    "runtime group-progress": async (deps, args) => await runGroupProgress(deps, args[0] ?? ""),
    "runtime contracts": async (deps) => await runRuntimeContracts(deps),
    "models check": async (deps) => await runRuntimeModelsCheck(deps),
    "models persist-key": async (deps, args, options) => await runRuntimeModelsPersistKey(deps, args[0] ?? "", options.fromPi, options.confirm),
    "runtime profile analyze": async (deps, _args, options) => await runRuntimeProfileAnalyze(deps, options.sha, options.out, options.capability),
    "runtime profile observe": async (deps, _args, options) => await runRuntimeProfileObserve(deps, options.from),
    "runtime profile propose": async (deps, _args, options) => await runRuntimeProfilePropose(deps, options.from, options.out, options.against),
    "runtime profile prune": async (deps, _args, options) => await runRuntimeProfilePrune(deps, options.plan, options.confirm),
    "runtime profile replay": async (deps, _args, options) => await runRuntimeProfileReplay(deps, options.sha, options.all),
    "runtime profile status": async (deps, _args, options) => await runRuntimeProfileStatus(deps, options.sha),
    "runtime profile watch": async (deps, _args, options) => await runRuntimeProfileWatch(deps, options.once, options.from),
    "runtime profile write": async (deps, _args, options) =>
      await runRuntimeProfileWrite(deps, {
        from: options.from,
        sha: options.sha,
        allowUnretained: options.allowUnretained,
        confirm: options.confirm,
        sliceReview: options.sliceReview,
        capability: options.capability,
        expectedReviewedSha: options.expectedReviewedSha,
      }),
    "runtime re-adopt": async (deps, _args, options) => await runRuntimeReAdopt(deps, options.confirm),
    "runtime operation-recovery": async (deps, _args, options) => await runRuntimeOperationRecovery(deps, options.confirm),
    "runtime watchdog run": async (deps) => await runRuntimeWatchdog(deps),
    "runtime modeld run": async (deps) => await runRuntimeModeld(deps),
    "runtime modeld status": async (deps) => await runRuntimeModeldStatus(deps),
    "runtime modeld replace": async (deps, _args, options) => await runRuntimeModeldReplace(deps, options),
  };
}

function addLeaf(
  deps: CliDeps,
  program: Command,
  parents: Map<string, Command>,
  leaf: LeafCommand,
  action: LeafAction,
  onManagementCommand?: (command: string) => void,
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
    if (leaf.protocol === "management") onManagementCommand?.(leafKey(leaf.path));
    const args = values
      .slice(0, leaf.arguments.length)
      .flatMap((value) => Array.isArray(value)
        ? value.map((entry) => String(entry))
        : [value === undefined ? undefined : String(value)]);
    const localOptions = (values[leaf.arguments.length] as CliOptions | undefined) ?? {};
    const globalOptions = program.opts<CliOptions>();
    if (globalOptions.profile !== undefined && leaf.profile === false) {
      if (leaf.localOnly) {
        throw new CliError(
          "runtime_local_only",
          "Box-local runtime commands cannot use --profile or remote transports.",
        );
      }
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

export function createProgram(deps: CliDeps, onManagementCommand?: (command: string) => void): Command {
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

  const managementRoots = new Set(MANAGEMENT_COMMANDS.map(leaf => leaf.path[0]));
  program.hook("preSubcommand", (_parent, command) => {
    if (managementRoots.has(command.name())) onManagementCommand?.(command.name());
  });
  for (const option of GLOBAL_OPTIONS) program.option(option.flags, option.description);
  program.configureOutput({
    writeOut: (chunk) => deps.stdout.write(chunk),
    writeErr: () => {
      // Usage failures are emitted as JSON by runCli.
    },
  });
  program.action(() => {
    throw usage("Missing command. Try grokbox --help or grokbox skills get grokbox.");
  });

  const bindings = actionBindings();
  const parents = new Map<string, Command>();
  for (const leaf of LEAF_COMMANDS) {
    const key = leafKey(leaf.path);
    const action = bindings[key];
    if (!action) throw new Error(`No implementation binding for registry leaf '${key}'.`);
    addLeaf(deps, program, parents, leaf, action, onManagementCommand);
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
  let managementCommand: string | undefined;
  const program = createProgram(deps, command => { managementCommand = command; });
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
      if (managementCommand) return writeManagementFailure(deps, managementCommand, new ManagementClientError("invalid_input", "Input does not match the command schema.", { parserCode: error.code }));
      writeFailure(deps.stderr, usage(publicCommanderMessage(error)));
      return 2;
    }
    if (managementCommand) return writeManagementFailure(deps, managementCommand, error);
    if (error instanceof CliError) {
      writeFailure(deps.stderr, error);
      return error.exitCode;
    }
    if (error instanceof ConfigError) {
      const mapped = new CliError(error.code, error.message, {
        ...(typeof error.context?.operationId === "string" ? { context: { operationId: error.context.operationId, phase: "config-commit" } } : {}),
      });
      writeFailure(deps.stderr, mapped);
      return mapped.exitCode;
    }
    if (error instanceof BoxRuntimeError) {
      const mapped = new CliError(error.code, error.message, { next: error.next, failureCode: error.failureCode });
      writeFailure(deps.stderr, mapped);
      return mapped.exitCode;
    }
    writeFailure(deps.stderr, new CliError("gateway_internal", unexpectedMessage(error)));
    return 15;
  }
}
