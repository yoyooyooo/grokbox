import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { constants } from "node:fs";
import { appendFile, chmod, mkdir, lstat, open, opendir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HostResourceError as CliError } from "./host-resource-contract.ts";
import type { GovernedFilesystem } from "./governed-filesystem.node.ts";
import type { ProcessAuthority } from "./job-process.node.ts";
import { acquireAdvisoryGate, type AdvisoryGate } from "./advisory-gate.node.ts";
import { assertSafeDirectory, readConfigSource } from "./config-layout.node.ts";
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const LOG_RECORD_MAX = 64 * 1024;
const LOG_RECORD_COUNT_MAX = 4096;
const LOG_RPC_MAX = 256 * 1024;
// Safety identities never share log TTL. A full bounded store refuses new work.
const JOB_RECORD_MAX = 4096;
const HISTORY_LOG_MEMORY_MAX = 32 * 1024 * 1024;
const SAFE_ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } as const;

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
export type JobScope = { installationId: string; principalId: string; requestId: string; policyRevision: string };
export type JobSubmit = {
  scope: JobScope;
  jobId: string;
  cwd?: string;
  argv: string[];
  environment: Record<string, string>;
  runTimeoutMs: number;
  output: "capture" | "discard";
  shell: boolean;
};
export type JobProjection = {
  jobId: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  cwd: string;
  command: { executable: string; argumentCount: number; shell: boolean };
  output: "capture" | "discard";
  runTimeoutMs: number;
  exitCode?: number;
  signal?: string;
  reason?: string;
  cancelOperationId?: string;
  logs: { bytes: number; nextOffset: number; truncated: boolean };
};
export type JobLogEvent = {
  offset: number;
  nextOffset: number;
  stream: "stdout" | "stderr";
  observedAt: number;
  bytes: number;
  contentBase64: string;
};

export type JobLifecycleEvent = {
  jobId: string;
  state: JobState;
  reason?: string;
  cancelOperationId?: string;
};

type PersistedJob = JobProjection & { schemaVersion: 1; scope: JobScope; fingerprint: string; serviceGeneration: string };
type ActiveJob = PersistedJob & {
  request?: JobSubmit;
  authorize?: () => Promise<void>;
  stateWrites?: Promise<void>;
  lastPublished?: PersistedJob;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  escalation?: Promise<void>;
  leaderStartTime?: string;
  launching?: boolean;
  logReservedBytes: number;
  logReservedEvents: number;
  logsLoaded: boolean;
  cancelPersistence?: Promise<void>;
  cancellationQueue: Promise<void>;
  terminalIntent?: "cancelled" | "interrupted" | "timeout";
  logEvents: JobLogEvent[];
  logQueue: Promise<void>;
  waiters: Set<() => void>;
};

function canonicalBase64(value: string, bytes: number): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value;
}

type LinuxProcessIdentity = { pid: number; processGroup: number; startTime: string };

async function linuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = value.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = value.slice(commandEnd + 2).trim().split(/\s+/);
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(processGroup) || !startTime || !/^\d+$/.test(startTime)) return undefined;
    return { pid, processGroup, startTime };
  } catch {
    return undefined;
  }
}

async function linuxProcessGroup(processGroup: number): Promise<LinuxProcessIdentity[]> {
  const identities: LinuxProcessIdentity[] = [];
  const directory = await opendir("/proc");
  try {
    for await (const entry of directory) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const identity = await linuxProcessIdentity(Number(entry.name));
      if (identity?.processGroup === processGroup) identities.push(identity);
    }
  } finally {
    try { await directory.close(); } catch {}
  }
  return identities;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function currentFields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value), allowed = [...required, ...optional];
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => {
    if (typeof key !== "string" || !allowed.includes(key)) return false;
    const field = Object.getOwnPropertyDescriptor(value, key);
    return !!field && field.enumerable && "value" in field;
  });
}
function sanitizePersisted(value: unknown, expectedJobId: string): PersistedJob | null {
  if (!currentFields(value, ["schemaVersion", "scope", "jobId", "state", "createdAt", "cwd", "command", "output", "runTimeoutMs", "logs", "fingerprint", "serviceGeneration"],
    ["startedAt", "finishedAt", "exitCode", "signal", "reason", "cancelOperationId"]) || value.schemaVersion !== 1 || value.jobId !== expectedJobId || typeof value.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.fingerprint) || typeof value.serviceGeneration !== "string" || !JOB_ID.test(value.serviceGeneration) ||
    typeof value.state !== "string" || !new Set(["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "unknown"]).has(value.state) ||
    typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || typeof value.cwd !== "string" ||
    !currentFields(value.command, ["executable", "argumentCount", "shell"]) || typeof value.command.executable !== "string" ||
    typeof value.command.argumentCount !== "number" || !Number.isSafeInteger(value.command.argumentCount) || typeof value.command.shell !== "boolean" ||
    (value.output !== "capture" && value.output !== "discard") || typeof value.runTimeoutMs !== "number" || !Number.isSafeInteger(value.runTimeoutMs) ||
    !currentFields(value.logs, ["bytes", "nextOffset", "truncated"]) || typeof value.logs.bytes !== "number" || !Number.isSafeInteger(value.logs.bytes) || value.logs.bytes < 0 ||
    typeof value.logs.nextOffset !== "number" || !Number.isSafeInteger(value.logs.nextOffset) || value.logs.nextOffset < 0 ||
    value.logs.bytes !== value.logs.nextOffset || typeof value.logs.truncated !== "boolean") return null;
  const optionalNumber = (key: "startedAt" | "finishedAt" | "exitCode") => value[key] === undefined || (typeof value[key] === "number" && Number.isSafeInteger(value[key]));
  if (!optionalNumber("startedAt") || !optionalNumber("finishedAt") || !optionalNumber("exitCode") ||
    (value.signal !== undefined && typeof value.signal !== "string") || (value.reason !== undefined && typeof value.reason !== "string") ||
    (value.cancelOperationId !== undefined && typeof value.cancelOperationId !== "string")) return null;
  const scope = value.scope;
  if (!currentFields(scope, ["installationId", "policyRevision", "principalId", "requestId"])
    || typeof scope.installationId !== "string" || !JOB_ID.test(scope.installationId) || typeof scope.principalId !== "string" || !scope.principalId || scope.principalId.length > 128
    || typeof scope.requestId !== "string" || !JOB_ID.test(scope.requestId) || typeof scope.policyRevision !== "string" || !/^[a-f0-9]{64}$/.test(scope.policyRevision)) return null;
  return {
    schemaVersion: 1, scope: structuredClone(scope) as JobScope, jobId: expectedJobId, state: value.state as JobState, createdAt: value.createdAt,
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt as number }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt as number }),
    cwd: value.cwd,
    command: { executable: value.command.executable, argumentCount: value.command.argumentCount, shell: value.command.shell },
    output: value.output, runTimeoutMs: value.runTimeoutMs,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number }),
    ...(value.signal === undefined ? {} : { signal: value.signal as string }),
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    ...(value.cancelOperationId === undefined ? {} : { cancelOperationId: value.cancelOperationId as string }),
    logs: { bytes: value.logs.bytes, nextOffset: value.logs.nextOffset, truncated: value.logs.truncated },
    fingerprint: value.fingerprint, serviceGeneration: value.serviceGeneration,
  };
}

export type JobStoredRecord = PersistedJob;
export function jobRequestFingerprint(request: JobSubmit & { cwd: string }): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}
export async function listJobRecords(configDir: string): Promise<JobStoredRecord[]> {
  const root = join(configDir, "jobs");
  try { await lstat(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  await assertSafeDirectory(root);
  const rows: JobStoredRecord[] = [], entries = await opendir(root); let inspected = 0;
  for await (const entry of entries) {
    if (++inspected > JOB_RECORD_MAX + 32) throw new CliError("job_interrupted", "Job inspection capacity exceeded; history was not deleted.");
    if (!JOB_ID.test(entry.name)) continue;
    const row = await readJobRecord(configDir, entry.name);
    if (!row) throw new CliError("job_interrupted", "Job history changed while being read.");
    rows.push(row);
  }
  return rows;
}
/** The same codec, read-only: history stays inspectable without executable policy
 * or a live manager. An absent receipt is never permission to dispatch. */
export async function readJobRecord(configDir: string, jobId: string): Promise<JobStoredRecord | null> {
  if (!JOB_ID.test(jobId)) throw new CliError("process_invalid", "Invalid Job identity.");
  const directory = join(configDir, "jobs", jobId);
  await assertSafeDirectory(configDir);
  try { await lstat(join(configDir, "jobs")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  await assertSafeDirectory(join(configDir, "jobs"));
  try { await lstat(directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  await assertSafeDirectory(directory);
  const value = sanitizePersisted((await readConfigSource(join(directory, "state.json")))!.value, jobId);
  if (!value) throw new CliError("job_interrupted", "The retained Job receipt is unavailable or unsupported.");
  return value;
}

async function readJobLogEvents(directory: string, expectedBytes: number): Promise<JobLogEvent[]> {
  let handle;
  try {
    await assertSafeDirectory(directory);
    handle = await open(join(directory, "logs.ndjson"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0
      || before.size > Math.min(256 * 1024 * 1024, expectedBytes * 3 + 1024 * 1024)) return [];
    const text = await handle.readFile("utf8"), after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return [];
    const lines = text.split("\n").filter(Boolean);
    if (lines.length > LOG_RECORD_COUNT_MAX) return [];
    const events: JobLogEvent[] = []; let offset = 0;
    for (const line of lines) {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || Object.keys(value).sort().join() !== "bytes,contentBase64,nextOffset,observedAt,offset,stream"
        || value.offset !== offset || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > LOG_RECORD_MAX
        || value.nextOffset !== offset + Number(value.bytes) || !["stdout", "stderr"].includes(String(value.stream))
        || !Number.isSafeInteger(value.observedAt) || Number(value.observedAt) < 1 || typeof value.contentBase64 !== "string"
        || !canonicalBase64(value.contentBase64, Number(value.bytes))) return [];
      offset = Number(value.nextOffset); events.push(value as JobLogEvent);
    }
    return events;
  } catch { return []; }
  finally { await handle?.close(); }
}
export async function readJobLogs(configDir: string, jobId: string, offset: number, limitBytes: number) {
  const job = await readJobRecord(configDir, jobId);
  if (!job) throw new CliError("job_not_found", "Job was not found.");
  const events = await readJobLogEvents(join(configDir, "jobs", jobId), job.logs.bytes);
  if ((events.at(-1)?.nextOffset ?? 0) !== job.logs.nextOffset) throw new CliError("job_interrupted", "Retained Job output has a gap; historical offsets were not reset.");
  if (!Number.isSafeInteger(offset) || !new Set([0, ...events.map(e => e.nextOffset)]).has(offset)
    || !Number.isSafeInteger(limitBytes) || limitBytes < LOG_RECORD_MAX || limitBytes > LOG_RPC_MAX) throw new CliError("process_invalid", "Invalid Job output cursor or bounds.");
  const selected: JobLogEvent[] = []; let bytes = 0;
  for (const event of events) if (event.offset >= offset) {
    if (bytes + event.bytes > limitBytes || selected.length >= 128) break;
    selected.push(event); bytes += event.bytes;
  }
  return { jobId, offset, nextOffset: selected.at(-1)?.nextOffset ?? offset, events: selected,
    state: ["queued", "running"].includes(job.state) ? "unknown" as const : job.state,
    complete: !["queued", "running", "unknown"].includes(job.state) && (selected.at(-1)?.nextOffset ?? offset) === job.logs.nextOffset, truncated: job.logs.truncated };
}

export class JobManager {
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly queue: string[] = [];
  private running = 0;
  private closing = false;
  private readonly launches = new Set<Promise<void>>();
  private readonly escalations = new Set<Promise<void>>();
  private admission = Promise.resolve();
  private constructor(
    private readonly root: string,
    private readonly generation: string,
    private readonly authority: ProcessAuthority,
    private readonly filesystem: GovernedFilesystem,
    private readonly now: () => number,
    private readonly onLifecycle?: (event: JobLifecycleEvent) => void,
    private readonly gate?: AdvisoryGate,
  ) {}
  private closed?: Promise<void>;

  static async create(
    configDir: string,
    authority: ProcessAuthority,
    filesystem: GovernedFilesystem,
    now: () => number,
    generation: string = randomUUID(),
    onLifecycle?: (event: JobLifecycleEvent) => void,
  ): Promise<JobManager> {
    const root = join(configDir, "jobs");
    await assertSafeDirectory(configDir, true); await assertSafeDirectory(root, true);
    const gate = await acquireAdvisoryGate(join(root, ".owner.gate"));
    if (!gate) throw new CliError("job_conflict", "This Job ledger already has a service owner.");
    const manager = new JobManager(root, generation, authority, filesystem, now, onLifecycle, gate);
    try { await manager.load(); return manager; }
    catch (error) { await gate.release(); throw error; }
  }

  private emitLifecycle(job: ActiveJob): void {
    this.onLifecycle?.({
      jobId: job.jobId,
      state: job.state,
      ...(job.reason === undefined ? {} : { reason: job.reason }),
      ...(job.cancelOperationId === undefined ? {} : { cancelOperationId: job.cancelOperationId }),
    });
  }

  private async load(): Promise<void> {
    const entries = await opendir(this.root);
    let inspected = 0;
    for await (const entry of entries) {
      if (inspected >= JOB_RECORD_MAX + 32) throw new CliError("job_interrupted", "Job safety records exceed the inspection bound; no history was removed.");
      inspected += 1;
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!JOB_ID.test(name)) continue;
      try {
        const statePath = join(this.root, name, "state.json");
        await assertSafeDirectory(join(this.root, name));
        const persisted = sanitizePersisted((await readConfigSource(statePath))!.value, name);
        if (!persisted) throw new Error("corrupt state");
        const recovered = persisted.state === "queued" || persisted.state === "running";
        if (recovered) {
          persisted.state = "unknown";
          persisted.finishedAt = this.now();
          persisted.reason = "service_restart";
        }
        const job: ActiveJob = {
          ...persisted, lastPublished: recovered ? undefined : structuredClone(persisted), logEvents: [], logReservedBytes: persisted.logs.bytes, logReservedEvents: 0, logsLoaded: false,
          logQueue: Promise.resolve(), cancellationQueue: Promise.resolve(), waiters: new Set(),
        };
        this.jobs.set(name, job);
        if (recovered) { await this.persist(job); this.emitLifecycle(job); }
      } catch {
        throw new CliError("job_interrupted", "A Job safety record is unavailable or unsupported; its bytes were preserved.");
      }
    }
    await this.pruneHistory();
    let aggregateBytes = 0;
    for (const job of [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)) {
      const events = await this.loadLogs(job.jobId);
      const eventBytes = events.reduce((sum, event) => sum + event.bytes, 0);
      const completeLog = (events.at(-1)?.nextOffset ?? 0) === job.logs.nextOffset && eventBytes === job.logs.bytes;
      if (completeLog) {
        job.logReservedEvents = events.length;
        if (aggregateBytes + eventBytes <= HISTORY_LOG_MEMORY_MAX) {
          job.logEvents = events;
          job.logsLoaded = true;
          aggregateBytes += eventBytes;
        } else {
          job.logEvents = [];
          job.logsLoaded = false;
        }
      } else if (job.logs.bytes > 0 || job.logs.nextOffset > 0) {
        // Missing/truncated logs are a read gap, not permission to reset offsets
        // and overwrite a historical outcome. Exact log reads will refuse.
        job.logsLoaded = false;
      }
    }
  }

  private async pruneHistory(): Promise<void> {
    // Reclaim only hot log copies. Execution guards, including unknown effects,
    // cannot expire into a fresh dispatch merely because a diagnostic TTL elapsed.
    this.enforceLogMemoryBudget();
  }

  private enforceLogMemoryBudget(preferredJobId?: string): void {
    const loaded = [...this.jobs.values()].filter((job) => job.logsLoaded).sort((a, b) => {
      if (a.jobId === preferredJobId) return -1;
      if (b.jobId === preferredJobId) return 1;
      const aTerminal = this.terminal(a.state);
      const bTerminal = this.terminal(b.state);
      if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
      return b.createdAt - a.createdAt;
    });
    let retainedBytes = 0;
    for (const job of loaded) {
      if (retainedBytes + job.logs.bytes <= HISTORY_LOG_MEMORY_MAX) {
        retainedBytes += job.logs.bytes;
      } else {
        job.logEvents = [];
        job.logsLoaded = false;
      }
    }
  }

  private async ensureLogsLoaded(job: ActiveJob): Promise<void> {
    if (job.logsLoaded) return;
    const reload = job.logQueue.then(async () => {
      if (job.logsLoaded) return;
      const events = await this.loadLogs(job.jobId);
      const bytes = events.reduce((sum, event) => sum + event.bytes, 0);
      if ((events.at(-1)?.nextOffset ?? 0) !== job.logs.nextOffset || bytes !== job.logs.bytes) {
        throw new CliError("job_interrupted", "Persisted Job logs are unavailable.");
      }
      job.logEvents = events;
      job.logReservedEvents = events.length;
      job.logsLoaded = true;
      this.enforceLogMemoryBudget(job.jobId);
    });
    job.logQueue = reload.catch(() => undefined);
    await reload;
  }

  private loadLogs(jobId: string): Promise<JobLogEvent[]> {
    const job = this.jobs.get(jobId);
    return job ? readJobLogEvents(join(this.root, jobId), job.logs.bytes) : Promise.resolve([]);
  }

  private projection(job: ActiveJob): JobProjection {
    const { schemaVersion: _schema, scope: _scope, authorize: _authorize, stateWrites: _stateWrites, lastPublished: _published, fingerprint: _fingerprint, serviceGeneration: _generation, request: _request, child: _child,
      timer: _timer, escalation: _escalation, leaderStartTime: _leaderStartTime, launching: _launching, logReservedBytes: _reserved,
      logReservedEvents: _reservedEvents, logsLoaded: _logsLoaded, cancelPersistence: _cancelPersistence,
      cancellationQueue: _cancellationQueue,
      terminalIntent: _intent, logEvents: _events,
      logQueue: _queue, waiters: _waiters, ...projection } = job;
    return structuredClone(projection);
  }

  private persist(job: ActiveJob): Promise<void> {
    const publication = (job.stateWrites ?? Promise.resolve()).catch(() => undefined).then(() => this.publish(job));
    job.stateWrites = publication;
    return publication;
  }
  private async publish(job: ActiveJob): Promise<void> {
    const dir = join(this.root, job.jobId);
    await assertSafeDirectory(dir, true); await syncDirectory(this.root);
    const path = join(dir, "state.json");
    const temporary = join(dir, `.state.${randomUUID()}.tmp`);
    const persisted: PersistedJob = { schemaVersion: 1, scope: job.scope, ...this.projection(job), fingerprint: job.fingerprint, serviceGeneration: job.serviceGeneration };
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(persisted, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(dir);
    // This is the result of this writer's completed publication, not a separate
    // cache or a projection of mutable process state. Active readers must not
    // race the owner's next atomic rename by reopening its pathname.
    job.lastPublished = structuredClone(persisted);
  }

  private async publishTerminal(job: ActiveJob): Promise<void> {
    job.authorize = undefined;
    try {
      await this.persist(job);
    } catch {
      job.state = "unknown";
      job.reason = "terminal_persistence_failed";
      job.finishedAt ??= this.now();
      await this.persist(job).catch(() => undefined);
    }
    this.notify(job);
    this.emitLifecycle(job);
    void this.pruneHistory();
  }

  private validate(request: JobSubmit): void {
    const policy = this.authority.policy;
    if (!request.scope || !JOB_ID.test(request.scope.installationId) || !JOB_ID.test(request.scope.requestId) || !request.scope.principalId || request.scope.principalId.length > 128 || !/^[a-f0-9]{64}$/.test(request.scope.policyRevision)) throw new CliError("process_invalid", "Invalid Job scope.");
    if (!JOB_ID.test(request.jobId) || !Array.isArray(request.argv) || request.argv.length === 0 || request.argv.length > 256 ||
      request.argv.some((value) => typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 32 * 1024) ||
      request.argv.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 128 * 1024 ||
      !Number.isInteger(request.runTimeoutMs) || request.runTimeoutMs < 100 || request.runTimeoutMs > policy.maxRuntimeMs ||
      (request.output !== "capture" && request.output !== "discard") || typeof request.shell !== "boolean") {
      throw new CliError("process_invalid", "Job submission is invalid or exceeds policy bounds.");
    }
    const entries = Object.entries(request.environment);
    if (entries.length > 32 || entries.some(([key, value]) => !ENV_NAME.test(key) || !policy.environment.includes(key) ||
      Buffer.byteLength(value) > 8 * 1024 || value.includes("\0")) ||
      entries.reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0) > 32 * 1024) {
      throw new CliError("process_forbidden", "Job environment is not authorized.");
    }
    if (request.shell && request.argv.length !== 1) throw new CliError("process_invalid", "Shell mode accepts exactly one command string.");
  }

  async submit(request: JobSubmit, authorize?: () => Promise<void>): Promise<JobProjection> {
    // Capture before the first await; caller mutation cannot alter queued work.
    request = structuredClone(request);
    const prior = this.admission;
    let release!: () => void;
    this.admission = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await this.submitAdmitted(request, authorize); }
    finally { release(); }
  }

  private async submitAdmitted(request: JobSubmit, authorize?: () => Promise<void>): Promise<JobProjection> {
    this.validate(request);
    const cwd = request.cwd ?? `${this.authority.policy.defaultCwdRoot}:/`;
    const executableName = request.shell ? "shell" : request.argv[0]!;
    const fingerprint = jobRequestFingerprint({ ...request, cwd });
    const existing = this.jobs.get(request.jobId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CliError("job_conflict", "Job identity was reused with different input.");
      return this.projection(existing);
    }
    if (this.closing) throw new CliError("job_interrupted", "Job admission is closing.");
    // A path not loaded into this owner is not an invitation to overwrite it.
    try { await lstat(join(this.root, request.jobId)); throw new CliError("job_interrupted", "Job identity already has retained files outside this owner's view."); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await authorize?.();
    await this.authority.executable(executableName, request.shell);
    const directory = await this.filesystem.executionDirectory(cwd, this.authority.policy.cwdRoots);
    await directory.close();
    if (this.closing) throw new CliError("job_interrupted", "Job admission is closing.");
    const nonterminal = [...this.jobs.values()].filter((job) => job.state === "queued" || job.state === "running").length;
    if (nonterminal >= this.authority.policy.maxConcurrent + this.authority.policy.maxQueued) {
      throw new CliError("job_conflict", "Job queue is full.");
    }
    if (this.jobs.size >= JOB_RECORD_MAX) throw new CliError("job_conflict", "Job safety capacity is full; retained execution identities were not removed.");
    const job: ActiveJob = {
      schemaVersion: 1, scope: request.scope, authorize, jobId: request.jobId, state: "queued", createdAt: this.now(), cwd,
      command: { executable: executableName, argumentCount: request.shell ? 1 : request.argv.length - 1, shell: request.shell },
      output: request.output, runTimeoutMs: request.runTimeoutMs,
      logs: { bytes: 0, nextOffset: 0, truncated: false },
      fingerprint, serviceGeneration: this.generation, request: { ...request, cwd },
      logEvents: [], logReservedBytes: 0, logReservedEvents: 0, logsLoaded: true,
      logQueue: Promise.resolve(), cancellationQueue: Promise.resolve(), waiters: new Set(),
    };
    this.jobs.set(job.jobId, job);
    try {
      await this.persist(job);
    } catch {
      // Publication may have happened before acknowledgement failed. Keep the
      // identity occupied; never delete its directory and dispatch it again.
      job.state = "unknown"; job.reason = "admission_persistence_unknown"; job.request = undefined; job.authorize = undefined;
      throw new CliError("operation_outcome_unknown", "Job admission has no verified receipt; inspect its original identity.");
    }
    this.queue.push(job.jobId);
    this.emitLifecycle(job);
    void this.drain();
    return this.projection(job);
  }

  private async drain(): Promise<void> {
    while (!this.closing && this.running < this.authority.policy.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.state !== "queued" || !job.request) continue;
      this.running += 1;
      job.launching = true;
      const launched = this.launch(job).finally(() => {
        job.launching = false;
        this.running -= 1;
        this.launches.delete(launched);
        void this.drain();
      });
      this.launches.add(launched);
    }
  }

  private async stopBeforeSpawn(job: ActiveJob): Promise<boolean> {
    await job.cancelPersistence?.catch(() => undefined);
    if (!job.terminalIntent && !this.closing) return false;
    job.terminalIntent ??= "interrupted";
    job.state = job.terminalIntent === "cancelled" ? "cancelled" : "interrupted";
    job.reason ??= job.terminalIntent === "cancelled" ? "cancelled_before_spawn" : "service_shutdown";
    job.finishedAt = this.now();
    job.request = undefined;
    await this.publishTerminal(job);
    return true;
  }

  private async launch(job: ActiveJob): Promise<void> {
    let directory: Awaited<ReturnType<GovernedFilesystem["executionDirectory"]>> | undefined;
    let child: ChildProcess | undefined;
    let childClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let spawned = false;
    let terminalObserved = false;
    try {
      const request = job.request;
      if (!request) {
        job.terminalIntent ??= "interrupted";
        await this.stopBeforeSpawn(job);
        return;
      }
      if (await this.stopBeforeSpawn(job)) return;
      const executable = await this.authority.executable(job.command.executable, request.shell);
      if (await this.stopBeforeSpawn(job)) return;
      directory = await this.filesystem.executionDirectory(job.cwd, this.authority.policy.cwdRoots);
      if (await this.stopBeforeSpawn(job)) return;
      await directory.verify();
      if (await this.stopBeforeSpawn(job)) return;
      await job.authorize?.();
      job.authorize = undefined; // No retained receipt owns an HTTP caller/credential closure.
      if (await this.stopBeforeSpawn(job)) return;
      const args = request.shell ? ["-lc", request.argv[0]!] : request.argv.slice(1);
      const env = { ...SAFE_ENV, ...request.environment };
      child = spawn(executable.path, args, {
        cwd: directory.descriptorPath, env, detached: true,
        stdio: ["ignore", request.output === "capture" ? "pipe" : "ignore", request.output === "capture" ? "pipe" : "ignore"],
      });
      job.child = child;
      childClosed = new Promise((resolve) => child!.once("close", (code, signal) => resolve({ code, signal })));
      if (request.output === "capture") {
        child.stdout?.on("data", (chunk: Buffer) => {
          if (!job.logs.truncated) void this.appendLog(job, "stdout", Buffer.from(chunk));
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (!job.logs.truncated) void this.appendLog(job, "stderr", Buffer.from(chunk));
        });
      }
      await new Promise<void>((resolve, reject) => {
        child!.once("spawn", resolve);
        child!.once("error", reject);
      });
      spawned = true;
      const leader = child.pid ? await linuxProcessIdentity(child.pid) : undefined;
      if (leader && leader.processGroup !== child.pid) {
        throw new CliError("process_invalid", "Spawned process-group identity could not be verified.");
      }
      job.leaderStartTime = leader?.startTime;
      job.timer = setTimeout(() => {
        job.terminalIntent = "timeout";
        this.terminateGroup(job);
      }, request.runTimeoutMs);
      job.timer.unref();

      const preSpawnTerminal = job.state as JobState;
      if (this.closing || preSpawnTerminal === "interrupted") job.terminalIntent ??= "interrupted";
      else if (preSpawnTerminal === "cancelled") job.terminalIntent ??= "cancelled";
      job.state = "running"; job.startedAt = this.now();
      if (job.terminalIntent) this.terminateGroup(job);
      await directory.close(); directory = undefined;
      await this.persist(job); this.notify(job); this.emitLifecycle(job);

      const terminal = await childClosed;
      terminalObserved = true;
      await job.cancelPersistence?.catch(() => undefined);
      await job.logQueue;
      if (job.timer) clearTimeout(job.timer);
      if (job.terminalIntent && job.escalation) await job.escalation;
      if (job.terminalIntent === "cancelled") job.state = "cancelled";
      else if (job.terminalIntent === "interrupted") job.state = "interrupted";
      else if (job.terminalIntent === "timeout") { job.state = "failed"; job.reason = "timeout"; }
      else if (terminal.code === 0) job.state = "succeeded";
      else { job.state = "failed"; job.reason = terminal.signal ? "signal" : "exit_nonzero"; }
      job.exitCode = terminal.code ?? undefined;
      job.signal = terminal.signal ?? undefined;
      job.finishedAt = this.now(); job.child = undefined; job.request = undefined;
      await this.publishTerminal(job);
    } catch (error) {
      await directory?.close().catch(() => undefined);
      if (terminalObserved) {
        if (job.timer) clearTimeout(job.timer);
        job.state = "unknown";
        job.reason = "terminal_persistence_failed";
        job.finishedAt = this.now(); job.child = undefined; job.request = undefined;
        await this.publishTerminal(job);
        return;
      }
      if (spawned && childClosed) {
        job.terminalIntent ??= this.closing ? "interrupted" : job.state === "cancelled" ? "cancelled" : undefined;
        this.terminateGroup(job);
        await childClosed.catch(() => ({ code: null, signal: null }));
        await job.logQueue;
        if (job.escalation) await job.escalation;
      }
      if (job.timer) clearTimeout(job.timer);
      if (job.terminalIntent === "cancelled") {
        job.state = "cancelled";
        job.reason ??= "cancelled";
      } else if (this.closing || job.terminalIntent === "interrupted") {
        job.state = "interrupted";
        job.reason ??= "service_shutdown";
      } else if (job.terminalIntent === "timeout") {
        job.state = "failed";
        job.reason = "timeout";
      } else if (spawned) {
        job.state = "unknown";
        job.reason = "runtime_management_failed";
      } else {
        job.state = "failed";
        job.reason = error instanceof CliError ? error.code : "spawn_error";
      }
      job.finishedAt = this.now(); job.child = undefined; job.request = undefined;
      await this.publishTerminal(job);
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }

  private authorizedProcessGroup(job: ActiveJob): Promise<LinuxProcessIdentity[]> {
    const pid = job.child?.pid;
    const leaderStartTime = job.leaderStartTime;
    if (!pid || !leaderStartTime) return Promise.resolve([]);
    return linuxProcessGroup(pid).then((members) => {
      const leader = members.find((member) => member.pid === pid);
      return leader?.startTime === leaderStartTime ? members : [];
    }).catch(() => []);
  }

  private terminateGroup(job: ActiveJob, authorized = this.authorizedProcessGroup(job)): void {
    if (job.escalation || !job.child?.pid) return;
    const processGroup = job.child.pid;
    const escalation = (async () => {
      const originalMembers = await authorized;
      if (originalMembers.length === 0) return;
      const original = new Set(originalMembers.map((member) => `${member.pid}:${member.startTime}`));
      const beforeTerm = await linuxProcessGroup(processGroup).catch(() => []);
      if (!beforeTerm.some((member) => original.has(`${member.pid}:${member.startTime}`))) return;
      this.signalPidGroup(processGroup, "SIGTERM");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5_000);
      });
      const currentMembers = await linuxProcessGroup(processGroup).catch(() => []);
      if (currentMembers.some((member) => original.has(`${member.pid}:${member.startTime}`))) {
        this.signalPidGroup(processGroup, "SIGKILL");
      }
    })().finally(() => {
      this.escalations.delete(escalation);
      if (job.escalation === escalation) job.escalation = undefined;
    });
    job.escalation = escalation;
    this.escalations.add(escalation);
  }

  private signalPidGroup(pid: number, signal: NodeJS.Signals): void {
    try { process.kill(-pid, signal); } catch {}
  }

  private async appendLog(job: ActiveJob, stream: "stdout" | "stderr", content: Buffer): Promise<void> {
    const remainingBytes = this.authority.policy.maxOutputBytes - job.logReservedBytes;
    const remainingRecords = LOG_RECORD_COUNT_MAX - job.logReservedEvents;
    if (remainingBytes <= 0 || remainingRecords <= 0) {
      job.logs.truncated = true;
      return;
    }
    const admitted = content.subarray(0, Math.min(remainingBytes, remainingRecords * LOG_RECORD_MAX));
    job.logReservedBytes += admitted.length;
    job.logReservedEvents += Math.ceil(admitted.length / LOG_RECORD_MAX);
    if (admitted.length < content.length) job.logs.truncated = true;
    content = admitted;
    job.logQueue = job.logQueue.then(async () => {
      for (let start = 0; start < content.length; start += LOG_RECORD_MAX) {
        const chunk = content.subarray(start, Math.min(content.length, start + LOG_RECORD_MAX));
        if (job.logs.bytes + chunk.length > this.authority.policy.maxOutputBytes) {
          job.logs.truncated = true; break;
        }
        const event: JobLogEvent = {
          offset: job.logs.nextOffset,
          nextOffset: job.logs.nextOffset + chunk.length,
          stream, observedAt: this.now(), bytes: chunk.length, contentBase64: chunk.toString("base64"),
        };
        job.logs.bytes += chunk.length; job.logs.nextOffset = event.nextOffset;
        if (job.logsLoaded) job.logEvents.push(event);
        const path = join(this.root, job.jobId, "logs.ndjson");
        await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
        await chmod(path, 0o600);
        this.notify(job);
      }
      await this.persist(job);
      this.enforceLogMemoryBudget(job.jobId);
    }).catch(() => { job.logs.truncated = true; });
    await job.logQueue;
  }

  private notify(job: ActiveJob): void { for (const waiter of job.waiters) waiter(); job.waiters.clear(); }
  private terminal(state: JobState): boolean { return !["queued", "running"].includes(state); }

  identity(jobId: string): JobScope | undefined { const scope = this.jobs.get(jobId)?.scope; return scope ? structuredClone(scope) : undefined; }
  async stableRecord(jobId: string): Promise<JobStoredRecord | null> {
    // Capture the current publication, not future log writes. A parallel caller
    // cannot turn an unpublished in-memory claim into a successful receipt.
    const publication = this.jobs.get(jobId)?.stateWrites;
    if (publication) await publication.catch(() => undefined);
    const current = this.record(jobId);
    if (!current) return null;
    // A subsequent publication can start while this caller is waiting. Return
    // this writer's completed publication, not that newer mutable process state.
    // Known local uncertainty must not be overwritten by older successful bytes.
    if (current.state === "unknown" || current.reason === "cancel_persistence_unknown") return current;
    const retained = this.jobs.get(jobId)?.lastPublished;
    if (!retained) throw new CliError("operation_outcome_unknown", "Job publication has no retained receipt.");
    return structuredClone(retained);
  }
  record(jobId: string): JobStoredRecord | null {
    const job = this.jobs.get(jobId); return job ? { schemaVersion: 1, ...this.projection(job), scope: structuredClone(job.scope), fingerprint: job.fingerprint, serviceGeneration: job.serviceGeneration } : null;
  }
  list(states: readonly JobState[] = [], limit = 50, owner?: Pick<JobScope, "installationId" | "principalId">): JobProjection[] {
    return [...this.jobs.values()].filter(job => !owner || job.scope?.installationId === owner.installationId && job.scope?.principalId === owner.principalId)
      .filter((job) => states.length === 0 || states.includes(job.state))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((job) => this.projection(job));
  }

  show(jobId: string): JobProjection {
    const job = this.jobs.get(jobId);
    if (!job) throw new CliError("job_not_found", "Job was not found.");
    return this.projection(job);
  }

  async waitTerminal(jobId: string, waitMs: number, signal?: AbortSignal): Promise<JobProjection> {
    const job = this.jobs.get(jobId);
    if (!job) throw new CliError("job_not_found", "Job was not found.");
    const deadline = Date.now() + Math.max(0, waitMs);
    while (!this.terminal(job.state) && Date.now() < deadline && !signal?.aborted) {
      await this.waitForChange(job, Math.max(1, deadline - Date.now()), signal);
    }
    return this.projection(job);
  }

  async wait(jobId: string, waitMs: number, signal?: AbortSignal): Promise<JobProjection> {
    const job = this.jobs.get(jobId);
    if (!job) throw new CliError("job_not_found", "Job was not found.");
    if (this.terminal(job.state) || waitMs <= 0) return this.projection(job);
    await this.waitForChange(job, waitMs, signal);
    return this.projection(job);
  }

  async logsRead(jobId: string, offset: number, limitBytes: number, waitMs: number, signal?: AbortSignal) {
    const job = this.jobs.get(jobId);
    if (!job) throw new CliError("job_not_found", "Job was not found.");
    await job.logQueue;
    await this.ensureLogsLoaded(job);
    const boundaries = new Set([0, ...job.logEvents.flatMap((event) => [event.offset, event.nextOffset])]);
    if (!Number.isSafeInteger(offset) || offset < 0 || !boundaries.has(offset) ||
      !Number.isSafeInteger(limitBytes) || limitBytes < LOG_RECORD_MAX || limitBytes > LOG_RPC_MAX ||
      !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new CliError("process_invalid", "Job log cursor or bounds are invalid.");
    }
    if (offset === job.logs.nextOffset && !this.terminal(job.state) && waitMs > 0) {
      await this.waitForChange(job, waitMs, signal);
      await job.logQueue;
      await this.ensureLogsLoaded(job);
    }
    let bytes = 0;
    const events: JobLogEvent[] = [];
    for (const event of job.logEvents) {
      if (event.offset < offset) continue;
      if (bytes + event.bytes > limitBytes || events.length >= 128) break;
      events.push(event);
      bytes += event.bytes;
    }
    return {
      jobId, offset, nextOffset: events.at(-1)?.nextOffset ?? offset,
      events, state: job.state, complete: this.terminal(job.state) && job.state !== "unknown" && (events.at(-1)?.nextOffset ?? offset) >= job.logs.nextOffset,
      truncated: job.logs.truncated,
    };
  }

  private async waitForChange(job: ActiveJob, waitMs: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const done = () => { clearTimeout(timer); job.waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
      timer = setTimeout(done, waitMs); timer.unref();
      job.waiters.add(done); signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  }

  private async recordCancellation(job: ActiveJob, cancelOperationId: string): Promise<void> {
    const authorized = this.authorizedProcessGroup(job);
    job.cancelOperationId = cancelOperationId;
    const pending = this.persist(job).then(() => {
      job.terminalIntent ??= "cancelled";
      if (job.child?.pid) this.terminateGroup(job, authorized);
    });
    job.cancelPersistence = pending;
    try {
      await pending;
    } catch (error) {
      // A failed acknowledgement is not proof publication did not happen.
      // Keep this cancellation identity occupied; another caller cannot replace it.
      job.reason = "cancel_persistence_unknown";
      throw new CliError("operation_outcome_unknown", "The original cancellation publication is uncertain.");
    } finally {
      if (job.cancelPersistence === pending) job.cancelPersistence = undefined;
    }
  }

  async cancel(jobId: string, cancelOperationId: string, authorize?: () => Promise<void>): Promise<JobProjection> {
    if (!JOB_ID.test(cancelOperationId)) throw new CliError("process_invalid", "Cancellation identity is invalid.");
    const job = this.jobs.get(jobId);
    if (!job) throw new CliError("job_not_found", "Job was not found.");
    const prior = job.cancellationQueue;
    let release!: () => void;
    job.cancellationQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      if (this.closing) throw new CliError("job_interrupted", "Job cancellation is closing.");
      if (job.cancelOperationId && job.cancelOperationId !== cancelOperationId) throw new CliError("job_conflict", "Another cancellation already owns this Job; inspect its original request.");
      if (!job.cancelOperationId) await authorize?.();
      return await this.cancelAdmitted(job, cancelOperationId);
    } finally {
      release();
    }
  }

  private async cancelAdmitted(job: ActiveJob, cancelOperationId: string): Promise<JobProjection> {
    if (job.cancelOperationId) {
      await job.cancelPersistence?.catch(() => undefined);
      if (this.closing) throw new CliError("job_interrupted", "Job cancellation is closing.");
      if (job.cancelOperationId) return this.projection(job);
    }
    if (job.state === "queued") {
      if (job.launching) {
        await this.recordCancellation(job, cancelOperationId);
        if (!job.escalation) this.terminateGroup(job);
        return this.projection(job);
      }
      const queuedIndex = this.queue.indexOf(job.jobId);
      if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
      job.cancelOperationId = cancelOperationId;
      job.terminalIntent = "cancelled";
      job.reason = "cancelled_before_spawn";
      job.state = "cancelled"; job.finishedAt = this.now(); job.request = undefined;
      const persistence = (async () => {
        try {
          await this.persist(job);
        } catch (error) {
          // Removal from the runnable queue precedes the cancellation commit.
          // Never requeue after a lost commit acknowledgement: cancellation may
          // already be durable. Preserve uncertainty and the original request.
          job.state = "unknown"; job.reason = "cancel_persistence_unknown";
          job.request = undefined; job.authorize = undefined;
          throw new CliError("operation_outcome_unknown", "The original queued cancellation publication is uncertain.");
        }
      })();
      job.cancelPersistence = persistence;
      try {
        await persistence;
      } finally {
        if (job.cancelPersistence === persistence) job.cancelPersistence = undefined;
      }
      job.authorize = undefined;
      this.notify(job); this.emitLifecycle(job); void this.pruneHistory();
      return this.projection(job);
    }
    if (job.state === "running") {
      await this.recordCancellation(job, cancelOperationId);
      if (job.state === "running" && !job.escalation) this.terminateGroup(job);
    }
    return this.projection(job);
  }

  close(): Promise<void> {
    return this.closed ??= this.closeOwned().finally(() => this.gate?.release());
  }
  private async closeOwned(): Promise<void> {
    this.closing = true;
    await this.admission;
    await Promise.allSettled([...this.jobs.values()].map((job) => job.cancellationQueue));
    const failures: unknown[] = [];
    for (const job of this.jobs.values()) {
      try { if (job.state === "queued") {
        job.terminalIntent ??= "interrupted";
        if (job.terminalIntent !== "cancelled") job.reason = "service_shutdown";
        if (job.launching) {
          this.terminateGroup(job);
          await this.persist(job);
        } else {
          job.state = job.terminalIntent === "cancelled" ? "cancelled" : "interrupted";
          job.finishedAt = this.now(); job.request = undefined;
          await this.publishTerminal(job);
        }
      } else if (job.state === "running") {
        job.terminalIntent ??= "interrupted"; this.terminateGroup(job);
      } } catch (error) { failures.push(error); }
    }
    // A failed shutdown publication cannot release the physical owner while
    // acquired executions or writes can still finish against its successor.
    for (const result of await Promise.allSettled([...this.launches])) if (result.status === "rejected") failures.push(result.reason);
    for (const result of await Promise.allSettled([...this.escalations])) if (result.status === "rejected") failures.push(result.reason);
    for (const result of await Promise.allSettled([...this.jobs.values()].map(job => job.stateWrites))) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new CliError("job_interrupted", "Job cleanup settled with unavailable persistence; inspect retained history.");
  }
}
