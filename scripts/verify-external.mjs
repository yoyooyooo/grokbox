#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { jobStateProvesCleanup, productErrorCodeFromText } from "./external-validation-helpers.mjs";

const runner = process.env.GROKBOX_EXTERNAL_RUNNER;
const peer = process.env.GROKBOX_EXTERNAL_PEER;
const agentTarget = process.env.GROKBOX_EXTERNAL_AGENT;
const emptyFileProbe = process.env.GROKBOX_EXTERNAL_EMPTY_FILE;
const mutationRoot = process.env.GROKBOX_EXTERNAL_MUTATION_ROOT;
const packageSpec = process.env.GROKBOX_EXTERNAL_PACKAGE;
if (!runner || !peer || !agentTarget || !emptyFileProbe || !mutationRoot) {
  console.error(
    "Set GROKBOX_EXTERNAL_RUNNER, GROKBOX_EXTERNAL_PEER, GROKBOX_EXTERNAL_AGENT, GROKBOX_EXTERNAL_EMPTY_FILE, and GROKBOX_EXTERNAL_MUTATION_ROOT.",
  );
  process.exit(2);
}
if (!/^[a-z][a-z0-9-]{0,31}:\/(?:[^/]+\/)*[^/]+$/.test(emptyFileProbe)) {
  console.error("GROKBOX_EXTERNAL_EMPTY_FILE must use root:/relative/path syntax.");
  process.exit(2);
}

if (!/^[a-z][a-z0-9-]{0,31}$/.test(mutationRoot)) {
  console.error("GROKBOX_EXTERNAL_MUTATION_ROOT must be one named root.");
  process.exit(2);
}
if (packageSpec !== undefined && !/^grokbox@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageSpec)) {
  console.error("GROKBOX_EXTERNAL_PACKAGE must be an exact grokbox package version.");
  process.exit(2);
}

function execute(file, args, label) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
    killSignal: "SIGTERM",
  });
  if (result.error || result.status !== 0) {
    if (process.env.GROKBOX_EXTERNAL_DEBUG === "1") {
      const diagnostic = String(result.stderr || result.stdout)
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/gbox_[A-Za-z0-9]+/g, "[redacted]")
        .slice(0, 2000);
      console.error(diagnostic);
    }
    throw new Error(`${label} failed with exit ${result.status ?? 1}.`);
  }
  return result.stdout;
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function remoteAttempt(command, label) {
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", runner, command], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
    killSignal: "SIGTERM",
  });
  if (result.error || result.status === null || result.status === 255) {
    throw new Error(`${label} failed at the SSH boundary.`);
  }
  return result;
}

function remote(command, label) {
  const result = remoteAttempt(command, label);
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}.`);
  return result.stdout;
}

function productErrorCode(result, label) {
  const code = productErrorCodeFromText(result.stderr);
  if (code !== null) return code;
  throw new Error(`${label} did not return one product error envelope.`);
}

function remoteExpectedFailure(command, label, expectedExit, expectedCode) {
  const result = remoteAttempt(command, label);
  if (result.status !== expectedExit || productErrorCode(result, label) !== expectedCode) {
    throw new Error(`${label} did not return ${expectedCode}/${expectedExit}.`);
  }
  return true;
}

const repoRoot = resolve(import.meta.dirname, "..");
const localHost = execute("hostname", [], "local hostname").trim();
const remoteHost = remote("hostname", "external hostname").trim();
if (!remoteHost || remoteHost === localHost) {
  throw new Error("External preflight rejected a same-host runner.");
}

const preflight = remote(
  "set -eu; command -v node >/dev/null; command -v ssh >/dev/null; command -v scp >/dev/null; test -d \"$HOME/.Trash\"; if command -v npm >/dev/null; then installer=npm; elif command -v bun >/dev/null; then installer=bun; else exit 1; fi; INSTALLER=\"$installer\" node -p \"JSON.stringify({platform:process.platform,node:process.versions.node,home:require('node:os').homedir(),installer:process.env.INSTALLER})\"",
  "external runtime preflight",
).trim();
const runtime = JSON.parse(preflight);
if (Number(String(runtime.node).split(".")[0]) < 20) {
  throw new Error("External runner requires Node.js 20 or newer.");
}

const localTrash = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Trash", "files");
mkdirSync(localTrash, { recursive: true });
const localTemp = mkdtempSync(join(localTrash, "grokbox-external-"));
const runId = randomUUID();
const remoteRoot = `${runtime.home}/.Trash/grokbox-external-${runId}`;
const remotePrefix = `${remoteRoot}/prefix`;
const remoteConfig = `${runtime.home}/.grokbox-verification`;
let cleanupCliAttempt = null;
let activeJobId = null;
let mutationDirectory = null;
let syntheticAgentId = null;
let syntheticAgentName = null;
let syntheticGroupId = null;
let syntheticGroupName = null;
let jobCleanup = "not-started";
let filesystemCleanup = "not-started";
let managementCleanup = "not-started";
const evidence = {
  version: 3,
  runId,
  roles: {
    controller: { distinctFromExternal: true },
    external: { platform: runtime.platform, nodeMajor: Number(String(runtime.node).split(".")[0]) },
    box: { reachedBy: "BatchMode SSH bootstrap", transport: "tailnet HTTPS" },
  },
  package: {
    source: packageSpec ? "registry" : "local-tarball",
    installer: runtime.installer,
    grokboxBin: false,
    gboxBin: false,
    clientVersion: null,
  },
  operations: { bootstrap: null, job: null, filesystem: null },
  generations: { daemonBefore: null, daemonAfter: null },
  checks: {},
  credentialState: "pending",
  cleanup: {
    localWorkspace: "pending",
    runnerWorkspace: "pending",
    job: "pending",
    filesystem: "pending",
    management: "pending",
  },
  completedAt: null,
};

try {
  remote(`mkdir -p ${quote(remoteRoot)}`, "external workspace creation");
  let installSpec;
  if (packageSpec) {
    installSpec = packageSpec;
  } else {
    execute("npm", ["run", "build"], "local Node build");
    execute("npm", ["pack", "--ignore-scripts", "--pack-destination", localTemp, repoRoot], "local npm pack");
    const packages = readdirSync(localTemp).filter((entry) => entry.endsWith(".tgz"));
    if (packages.length !== 1) throw new Error("Local pack did not produce exactly one archive.");
    const packagePath = join(localTemp, packages[0]);
    execute(
      "scp",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", packagePath, `${runner}:${remoteRoot}/grokbox.tgz`],
      "external package transfer",
    );
    installSpec = `${remoteRoot}/grokbox.tgz`;
  }

  if (runtime.installer === "npm") {
    remote(
      `npm install --ignore-scripts --omit=dev --no-audit --no-fund --prefix ${quote(remotePrefix)} ${quote(installSpec)} >/dev/null`,
      "external isolated install",
    );
  } else if (runtime.installer === "bun") {
    remote(
      `BUN_INSTALL=${quote(remotePrefix)} bun add --global --exact --registry https://registry.npmjs.org ${quote(installSpec)} >/dev/null`,
      "external isolated install",
    );
  } else {
    throw new Error("External runtime selected an unsupported package installer.");
  }

  const binDir = runtime.installer === "npm" ? `${remotePrefix}/node_modules/.bin` : `${remotePrefix}/bin`;
  const grokbox = `${binDir}/grokbox`;
  const gbox = `${binDir}/gbox`;
  const envPrefix = `PATH=/usr/local/bin:/opt/homebrew/bin:$PATH GROKBOX_CONFIG_DIR=${quote(remoteConfig)}`;
  const cli = (binary, args, label) => remote(
    `${envPrefix} ${quote(binary)} ${args.map(quote).join(" ")}`,
    label,
  );
  cleanupCliAttempt = (args, label) => remoteAttempt(
    `${envPrefix} ${quote(grokbox)} ${args.map(quote).join(" ")}`,
    label,
  );

  const grokboxVersion = cli(grokbox, ["--version"], "grokbox bin smoke").trim();
  const gboxVersion = cli(gbox, ["--version"], "gbox bin smoke").trim();
  evidence.package.grokboxBin = grokboxVersion.length > 0;
  evidence.package.gboxBin = gboxVersion === grokboxVersion;
  evidence.package.clientVersion = grokboxVersion;

  cli(
    grokbox,
    ["init", "default", "--peer", peer, "--bootstrap", "--yes"],
    "remote bootstrap",
  );
  const daemonStatus = JSON.parse(cli(grokbox, ["daemon", "status"], "remote daemon status"));
  const daemonStartEvent = JSON.parse(cli(
    grokbox,
    ["--timeout-ms", "60000", "events", "--once", "--sources", "daemon"],
    "remote daemon lifecycle event",
  ));
  const originalEventCursor = daemonStartEvent?.cursor;
  if (typeof originalEventCursor !== "string") throw new Error("External daemon event did not return a cursor.");
  const processExecutable = process.env.GROKBOX_EXTERNAL_EXECUTABLE ?? "node";
  const processCwd = `${mutationRoot}:/`;
  const shellRefused = remoteExpectedFailure(
    `${envPrefix} ${quote(grokbox)} ${["--timeout-ms", "60000", "exec", "run", "--shell", "--", "echo refused"].map(quote).join(" ")}`,
    "remote default shell refusal",
    22,
    "capability_unavailable",
  );
  jobCleanup = "pending";
  const jobSubmit = JSON.parse(cli(
    grokbox,
    ["--timeout-ms", "60000", "exec", "run", "--detach", "--cwd", processCwd, "--", processExecutable, "-e", "process.stdout.write('external-job');setTimeout(()=>{},30000)"],
    "remote structured Job submission",
  ));
  activeJobId = jobSubmit?.data?.jobId;
  const jobId = activeJobId;
  if (typeof jobId !== "string") throw new Error("External Job submission did not return an identity.");
  const jobEvent = JSON.parse(cli(
    grokbox,
    ["--timeout-ms", "60000", "events", "--once", "--sources", "job"],
    "remote Job lifecycle event",
  ));
  remote("sleep 1", "remote Job startup observation");
  const jobCancel = JSON.parse(cli(grokbox, ["--timeout-ms", "60000", "jobs", "cancel", jobId], "remote Job cancel"));
  cli(grokbox, ["--timeout-ms", "60000", "jobs", "logs", jobId, "--follow"], "remote Job log follow");
  const jobShow = JSON.parse(cli(grokbox, ["--timeout-ms", "60000", "jobs", "show", jobId], "remote Job show"));
  if (jobShow?.data?.state === "cancelled") jobCleanup = "completed";
  const jobList = JSON.parse(cli(grokbox, ["--timeout-ms", "60000", "jobs", "list", "--limit", "10"], "remote Job list"));
  const productTimeout = ["--timeout-ms", "60000"];
  const doctor = JSON.parse(cli(grokbox, [...productTimeout, "doctor"], "remote doctor"));
  const daemonEnsureNoop = JSON.parse(cli(
    grokbox,
    [...productTimeout, "daemon", "ensure"],
    "remote installed daemon ensure no-op",
  ));
  const recoverNoop = JSON.parse(cli(
    grokbox,
    [...productTimeout, "recover"],
    "remote healthy recovery no-op",
  ));
  const fsStat = JSON.parse(cli(
    grokbox,
    [...productTimeout, "fs", "stat", emptyFileProbe],
    "remote filesystem stat",
  ));
  const fsRead = JSON.parse(cli(
    grokbox,
    [...productTimeout, "fs", "read", emptyFileProbe],
    "remote filesystem read",
  ));
  const fsDownload = JSON.parse(cli(
    grokbox,
    [...productTimeout, "fs", "download", emptyFileProbe, `${remoteRoot}/keep.download`],
    "remote filesystem download",
  ));
  mutationDirectory = `${mutationRoot}:/grokbox-external-${runId}`;
  const writtenPath = `${mutationDirectory}/written.txt`;
  const uploadedPath = `${mutationDirectory}/uploaded.txt`;
  remote(`printf %s ${quote("external-ticket07-upload")} > ${quote(`${remoteRoot}/upload-source.txt`)}`, "external upload fixture");
  const fsMkdir = JSON.parse(cli(
    grokbox,
    [...productTimeout, "fs", "mkdir", mutationDirectory],
    "remote filesystem mkdir",
  ));
  filesystemCleanup = "pending";
  const fsWrite = JSON.parse(cli(
    grokbox,
    [...productTimeout, "fs", "write", writtenPath, "--text", "external-ticket07-write"],
    "remote filesystem write",
  ));
  const fsUpload = JSON.parse(cli(
    grokbox,
    [...productTimeout, "fs", "upload", `${remoteRoot}/upload-source.txt`, uploadedPath],
    "remote filesystem upload",
  ));
  const fsRemove = JSON.parse(cli(
    grokbox,
    [...productTimeout, "fs", "remove", uploadedPath, "--yes"],
    "remote filesystem recoverable remove",
  ));
  const fsRecursiveRemove = JSON.parse(cli(
    grokbox,
    [...productTimeout, "fs", "remove", mutationDirectory, "--recursive", "--yes"],
    "remote filesystem recursive remove",
  ));
  if (fsRecursiveRemove?.data?.state === "committed") {
    filesystemCleanup = "completed";
    mutationDirectory = null;
  }
  const agents = JSON.parse(cli(grokbox, [...productTimeout, "agents", "list"], "remote agents list"));
  const rows = Array.isArray(agents?.data?.agents) ? agents.data.agents : [];
  const exactId = rows.filter((row) => row?.id === agentTarget);
  const named = rows.filter((row) =>
    [row?.name, row?.title].some((value) =>
      typeof value === "string" && value.toLocaleLowerCase("en-US") === agentTarget.toLocaleLowerCase("en-US")
    )
  );
  const matches = exactId.length > 0 ? exactId : named;
  const target = matches.length === 1 ? matches[0]?.id : null;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("External verification agent target must resolve to exactly one visible non-group agent.");
  }

  managementCleanup = "pending";
  const syntheticNameSuffix = runId.slice(0, 8);
  syntheticAgentName = `grokbox-e2e-${syntheticNameSuffix}`;
  syntheticGroupName = `grokbox-e2e-group-${syntheticNameSuffix}`;
  const createdAgent = JSON.parse(cli(
    grokbox,
    [...productTimeout, "agents", "create", "--name", syntheticAgentName, "--instructions", "Bounded external verification object", "--nonce", runId],
    "remote synthetic agent create",
  ));
  syntheticAgentId = createdAgent?.data?.agent?.id;
  if (typeof syntheticAgentId !== "string" || syntheticAgentId.length === 0) {
    throw new Error("External synthetic agent creation did not return an identity.");
  }
  const updatedAgent = JSON.parse(cli(
    grokbox,
    [...productTimeout, "agents", "update", syntheticAgentId, "--title", "External verification"],
    "remote synthetic agent update",
  ));
  const createdGroup = JSON.parse(cli(
    grokbox,
    [...productTimeout, "groups", "create", "--name", syntheticGroupName, "--member", target],
    "remote synthetic group create",
  ));
  syntheticGroupId = createdGroup?.data?.group?.id;
  if (typeof syntheticGroupId !== "string" || syntheticGroupId.length === 0) {
    throw new Error("External synthetic group creation did not return an identity.");
  }
  const members = JSON.parse(cli(
    grokbox,
    [...productTimeout, "groups", "members", "add", syntheticGroupId, syntheticAgentId],
    "remote synthetic group membership",
  ));
  const deletedGroup = JSON.parse(cli(
    grokbox,
    [...productTimeout, "groups", "delete", syntheticGroupId, "--yes"],
    "remote synthetic group delete",
  ));
  syntheticGroupId = null;
  const deletedAgent = JSON.parse(cli(
    grokbox,
    [...productTimeout, "agents", "delete", syntheticAgentId, "--yes"],
    "remote synthetic agent delete",
  ));
  syntheticAgentId = null;
  const managementAgentsReconciled = JSON.parse(cli(
    grokbox,
    [...productTimeout, "agents", "list"],
    "remote synthetic agent cleanup reconciliation",
  ));
  const managementGroupsReconciled = JSON.parse(cli(
    grokbox,
    [...productTimeout, "groups", "list"],
    "remote synthetic group cleanup reconciliation",
  ));
  const remainingSynthetic =
    (Array.isArray(managementAgentsReconciled?.data?.agents)
      ? managementAgentsReconciled.data.agents.some((row) => row?.name === syntheticAgentName)
      : true) ||
    (Array.isArray(managementGroupsReconciled?.data?.groups)
      ? managementGroupsReconciled.data.groups.some((row) => row?.name === syntheticGroupName)
      : true);
  if (remainingSynthetic) throw new Error("External synthetic object cleanup did not reconcile.");
  managementCleanup = "completed";

  cli(grokbox, [...productTimeout, "history", "search", "status"], "remote history search");
  cli(grokbox, [...productTimeout, "history", "tail", target, "--limit", "1"], "remote history tail");
  cli(
    grokbox,
    [...productTimeout, "send", target, "--text", process.env.GROKBOX_EXTERNAL_PROMPT ?? "External verification. Reply with OK only."],
    "remote send",
  );
  const bootstrapRotation = JSON.parse(cli(
    grokbox,
    [...productTimeout, "daemon", "ensure", "--bootstrap", "--yes"],
    "remote daemon generation rotation",
  ));
  const generationGap = JSON.parse(cli(
    grokbox,
    [...productTimeout, "events", "--once", "--sources", "daemon", "--cursor", originalEventCursor],
    "remote cross-generation event recovery",
  ));

  evidence.checks = {
    protocolMajor: daemonStatus?.data?.protocolMajor ?? null,
    daemonVersion: daemonStatus?.data?.daemonVersion ?? null,
    transport: daemonStatus?.data?.transport ?? null,
    doctorOk: doctor?.data?.ok === true && doctor?.data?.health?.ok === true,
    doctorBoundaries:
      doctor?.data?.checks?.profile?.status === "pass" &&
      doctor?.data?.checks?.secretSession?.status === "pass" &&
      doctor?.data?.checks?.tailnet?.status === "pass" &&
      doctor?.data?.checks?.serve?.status === "pass" &&
      doctor?.data?.checks?.daemonHttp?.status === "pass" &&
      doctor?.data?.checks?.daemonAuth?.status === "pass" &&
      doctor?.data?.checks?.capabilities?.status === "pass" &&
      doctor?.data?.checks?.gateway?.status === "pass",
    networkReachable: doctor?.data?.checks?.networkReachable === true,
    credentialAccepted: doctor?.data?.checks?.sharedCredentialAccepted === true,
    daemonEnsureNoop: daemonEnsureNoop?.data?.ensured === true && daemonEnsureNoop?.data?.changed === false,
    recoverNoop:
      recoverNoop?.data?.recovered === true && recoverNoop?.data?.changed === false &&
      Array.isArray(recoverNoop?.data?.actions) && recoverNoop.data.actions.length === 0 &&
      recoverNoop?.data?.doctor?.ok === true,
    bootstrapOperationPresent:
      bootstrapRotation?.data?.changed === true &&
      typeof bootstrapRotation?.data?.operationId === "string" &&
      bootstrapRotation?.data?.audit?.action === "daemon-bootstrap",
    generationPresent: Number.isFinite(doctor?.meta?.gateway?.pid) && Number.isFinite(doctor?.meta?.gateway?.startedAt),
    daemonLifecycleEvent:
      daemonStartEvent?.event?.source === "daemon" && daemonStartEvent?.event?.kind === "started" &&
      typeof daemonStartEvent?.meta?.daemonGeneration === "string",
    jobLifecycleEvent:
      jobEvent?.event?.source === "job" && jobEvent?.event?.operationId === jobId &&
      jobEvent?.event?.payload?.jobId === jobId,
    crossGenerationGap:
      generationGap?.event?.source === "daemon" && generationGap?.event?.kind === "gap" &&
      generationGap?.event?.payload?.reason === "daemon_generation_changed" &&
      generationGap?.meta?.daemonGeneration !== daemonStartEvent?.meta?.daemonGeneration,
    processShellRefusedByDefault: shellRefused,
    processJobIdentity: typeof jobId === "string" && jobSubmit?.data?.command?.shell === false,
    processJobCancelled:
      jobCancel?.data?.jobId === jobId && jobShow?.data?.jobId === jobId && jobShow?.data?.state === "cancelled",
    processLogsBounded:
      Number.isSafeInteger(jobShow?.data?.logs?.bytes) && jobShow.data.logs.bytes > 0 &&
      Number.isSafeInteger(jobShow?.data?.logs?.nextOffset),
    processJobListed:
      Array.isArray(jobList?.data?.jobs) && jobList.data.jobs.some((job) => job?.jobId === jobId),
    agentTargetExplicit: typeof target === "string" && target.length > 0,
    agentManagement:
      updatedAgent?.data?.agent?.id === createdAgent?.data?.agent?.id &&
      updatedAgent?.data?.agent?.title === "External verification" &&
      deletedAgent?.data?.deleted?.kind === "agent",
    groupManagement:
      Array.isArray(members?.data?.members) &&
      members.data.members.some((member) => member?.id === createdAgent?.data?.agent?.id) &&
      deletedGroup?.data?.deleted?.kind === "group",
    filesystemRootNamed: fsStat?.data?.root === emptyFileProbe.split(":", 1)[0] && fsStat?.data?.path === emptyFileProbe,
    filesystemReadBounded: fsRead?.data?.size === 0 && fsRead?.data?.encoding === "utf8" && fsRead?.data?.content === "",
    filesystemDownloadVerified:
      fsDownload?.data?.size === 0 &&
      fsDownload?.data?.sha256 === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" &&
      fsDownload?.data?.verified === true,
    filesystemMkdirCommitted: fsMkdir?.data?.state === "committed" && fsMkdir?.data?.kind === "directory",
    filesystemWriteCommitted:
      fsWrite?.data?.state === "committed" &&
      fsWrite?.data?.size === Buffer.byteLength("external-ticket07-write") &&
      typeof fsWrite?.data?.sha256 === "string",
    filesystemUploadCommitted:
      fsUpload?.data?.state === "committed" &&
      fsUpload?.data?.size === Buffer.byteLength("external-ticket07-upload") &&
      typeof fsUpload?.data?.sha256 === "string",
    filesystemRemoveRecoverable:
      fsRemove?.data?.state === "committed" && fsRemove?.data?.recoverable === true &&
      fsRemove?.data?.trashId === fsRemove?.data?.operationId,
    filesystemRecursiveRemoveRecoverable:
      fsRecursiveRemove?.data?.state === "committed" && fsRecursiveRemove?.data?.recoverable === true &&
      fsRecursiveRemove?.data?.trashId === fsRecursiveRemove?.data?.operationId,
    roster: "passed",
    historySearch: "passed",
    historyTail: "passed",
    send: "accepted",
  };
  evidence.operations = {
    bootstrap: bootstrapRotation?.data?.operationId ?? null,
    job: jobId,
    filesystem: fsWrite?.data?.operationId ?? null,
  };
  evidence.generations = {
    daemonBefore: daemonStartEvent?.meta?.daemonGeneration ?? null,
    daemonAfter: generationGap?.meta?.daemonGeneration ?? null,
  };
  const profile = JSON.parse(cli(grokbox, ["profile", "show", "default"], "verification Profile show"));
  const tokenRef = profile?.data?.profile?.daemon_token_ref;
  if (typeof tokenRef !== "string" || !tokenRef.startsWith("file:")) {
    throw new Error("External verification Profile does not retain a file credential reference.");
  }
  remote(`test -f ${quote(tokenRef.slice(5))}`, "preserved credential check");
  evidence.credentialState = "preserved-in-dedicated-profile";

  const required = [
    evidence.package.grokboxBin,
    evidence.package.gboxBin,
    typeof evidence.package.clientVersion === "string" && evidence.package.clientVersion.length > 0,
    evidence.checks.protocolMajor === 1,
    typeof evidence.checks.daemonVersion === "string" && evidence.checks.daemonVersion.length > 0,
    evidence.checks.transport === "https",
    evidence.checks.doctorOk === true,
    evidence.checks.doctorBoundaries === true,
    evidence.checks.networkReachable === true,
    evidence.checks.credentialAccepted === true,
    evidence.checks.daemonEnsureNoop === true,
    evidence.checks.recoverNoop === true,
    evidence.checks.bootstrapOperationPresent === true,
    evidence.checks.generationPresent === true,
    evidence.checks.daemonLifecycleEvent === true,
    evidence.checks.jobLifecycleEvent === true,
    evidence.checks.crossGenerationGap === true,
    evidence.checks.processShellRefusedByDefault === true,
    evidence.checks.processJobIdentity === true,
    evidence.checks.processJobCancelled === true,
    evidence.checks.processLogsBounded === true,
    evidence.checks.processJobListed === true,
    evidence.checks.agentTargetExplicit === true,
    evidence.checks.agentManagement === true,
    evidence.checks.groupManagement === true,
    evidence.checks.filesystemRootNamed === true,
    evidence.checks.filesystemReadBounded === true,
    evidence.checks.filesystemDownloadVerified === true,
    evidence.checks.filesystemMkdirCommitted === true,
    evidence.checks.filesystemWriteCommitted === true,
    evidence.checks.filesystemUploadCommitted === true,
    evidence.checks.filesystemRemoveRecoverable === true,
    evidence.checks.filesystemRecursiveRemoveRecoverable === true,
    evidence.checks.roster === "passed",
    evidence.checks.historySearch === "passed",
    evidence.checks.historyTail === "passed",
    evidence.checks.send === "accepted",
    typeof evidence.operations.bootstrap === "string",
    typeof evidence.operations.job === "string",
    typeof evidence.operations.filesystem === "string",
    typeof evidence.generations.daemonBefore === "string",
    typeof evidence.generations.daemonAfter === "string" &&
      evidence.generations.daemonAfter !== evidence.generations.daemonBefore,
    evidence.credentialState === "preserved-in-dedicated-profile",
    jobCleanup === "completed",
    filesystemCleanup === "completed",
    managementCleanup === "completed",
  ];
  if (required.some((value) => !value)) {
    throw new Error("External verification acceptance checks are incomplete.");
  }
} finally {
  if (cleanupCliAttempt && activeJobId && jobCleanup !== "completed") {
    try {
      cleanupCliAttempt(
        ["--timeout-ms", "60000", "jobs", "cancel", activeJobId],
        "submitted Job cleanup",
      );
      const shown = cleanupCliAttempt(
        ["--timeout-ms", "60000", "jobs", "show", activeJobId],
        "submitted Job cleanup reconciliation",
      );
      if (shown.status === 0) {
        const state = JSON.parse(shown.stdout)?.data?.state;
        jobCleanup = jobStateProvesCleanup(state)
          ? "completed-after-failure"
          : "unknown";
      } else {
        jobCleanup = "unknown";
      }
    } catch {
      jobCleanup = "unknown";
    }
  }

  if (jobCleanup === "pending" && !activeJobId) jobCleanup = "unknown";

  if (cleanupCliAttempt && mutationDirectory && filesystemCleanup !== "completed") {
    try {
      const removed = cleanupCliAttempt(
        ["--timeout-ms", "60000", "fs", "remove", mutationDirectory, "--recursive", "--yes"],
        "filesystem fixture cleanup",
      );
      if (removed.status === 0 && JSON.parse(removed.stdout)?.data?.state === "committed") {
        filesystemCleanup = "completed-after-failure";
        mutationDirectory = null;
      } else {
        const stat = cleanupCliAttempt(
          ["--timeout-ms", "60000", "fs", "stat", mutationDirectory],
          "filesystem fixture cleanup reconciliation",
        );
        if (stat.status === 37 && productErrorCode(stat, "filesystem fixture cleanup reconciliation") === "fs_not_found") {
          filesystemCleanup = "completed-after-failure";
          mutationDirectory = null;
        } else {
          filesystemCleanup = "failed";
        }
      }
    } catch {
      filesystemCleanup = "unknown";
    }
  }

  if (cleanupCliAttempt && managementCleanup === "pending") {
    try {
      const listedAgents = cleanupCliAttempt(
        ["--timeout-ms", "60000", "agents", "list"],
        "synthetic agent cleanup discovery",
      );
      const listedGroups = cleanupCliAttempt(
        ["--timeout-ms", "60000", "groups", "list"],
        "synthetic group cleanup discovery",
      );
      if (listedAgents.status !== 0 || listedGroups.status !== 0) {
        throw new Error("Synthetic cleanup roster discovery failed.");
      }
      const agentRows = Array.isArray(JSON.parse(listedAgents.stdout)?.data?.agents)
        ? JSON.parse(listedAgents.stdout).data.agents
        : [];
      const groupRows = Array.isArray(JSON.parse(listedGroups.stdout)?.data?.groups)
        ? JSON.parse(listedGroups.stdout).data.groups
        : [];
      const groups = syntheticGroupName ? groupRows.filter((row) => row?.name === syntheticGroupName) : [];
      const agents = syntheticAgentName ? agentRows.filter((row) => row?.name === syntheticAgentName) : [];
      if (groups.length > 1 || agents.length > 1) throw new Error("Synthetic cleanup identity is ambiguous.");
      syntheticGroupId = syntheticGroupId ?? groups[0]?.id ?? null;
      syntheticAgentId = syntheticAgentId ?? agents[0]?.id ?? null;
      if (syntheticGroupId) {
        cleanupCliAttempt(
          ["--timeout-ms", "60000", "groups", "delete", syntheticGroupId, "--yes"],
          "synthetic group cleanup",
        );
      }
      if (syntheticAgentId) {
        cleanupCliAttempt(
          ["--timeout-ms", "60000", "agents", "delete", syntheticAgentId, "--yes"],
          "synthetic agent cleanup",
        );
      }
      const reconciledAgents = cleanupCliAttempt(
        ["--timeout-ms", "60000", "agents", "list"],
        "synthetic agent cleanup reconciliation",
      );
      const reconciledGroups = cleanupCliAttempt(
        ["--timeout-ms", "60000", "groups", "list"],
        "synthetic group cleanup reconciliation",
      );
      if (reconciledAgents.status !== 0 || reconciledGroups.status !== 0) {
        throw new Error("Synthetic cleanup reconciliation failed.");
      }
      const remainingAgents = Array.isArray(JSON.parse(reconciledAgents.stdout)?.data?.agents)
        ? JSON.parse(reconciledAgents.stdout).data.agents
        : [];
      const remainingGroups = Array.isArray(JSON.parse(reconciledGroups.stdout)?.data?.groups)
        ? JSON.parse(reconciledGroups.stdout).data.groups
        : [];
      const remains =
        remainingGroups.some((row) => syntheticGroupName && row?.name === syntheticGroupName) ||
        remainingAgents.some((row) => syntheticAgentName && row?.name === syntheticAgentName);
      managementCleanup = remains ? "failed" : "completed-after-failure";
      if (!remains) {
        syntheticGroupId = null;
        syntheticAgentId = null;
      }
    } catch {
      managementCleanup = "unknown";
    }
  }

  let runnerWorkspace = "unknown";
  if (remoteRoot.startsWith(`${runtime.home}/.Trash/`)) {
    try {
      runnerWorkspace = remoteAttempt(`test -d ${quote(remoteRoot)}`, "runner workspace verification").status === 0
        ? "staged-in-system-trash"
        : "not-created";
    } catch {
      runnerWorkspace = "unknown";
    }
  } else {
    runnerWorkspace = "failed";
  }
  evidence.cleanup = {
    localWorkspace: localTemp.startsWith(`${localTrash}/`) && existsSync(localTemp)
      ? "staged-in-system-trash"
      : "failed",
    runnerWorkspace,
    job: jobCleanup,
    filesystem: filesystemCleanup,
    management: managementCleanup,
  };
  evidence.completedAt = new Date().toISOString();
  const artifactDir = join(repoRoot, "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, `external-validation-${runId}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
}

const acceptedCleanup = new Set(["completed", "completed-after-failure", "not-started"]);
if (
  evidence.cleanup.localWorkspace !== "staged-in-system-trash" ||
  evidence.cleanup.runnerWorkspace !== "staged-in-system-trash" ||
  !acceptedCleanup.has(evidence.cleanup.job) ||
  !acceptedCleanup.has(evidence.cleanup.filesystem) ||
  !acceptedCleanup.has(evidence.cleanup.management)
) throw new Error("External cleanup could not be verified.");
console.log(JSON.stringify(evidence, null, 2));
