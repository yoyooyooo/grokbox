import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, opendir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorCode } from "../errors.ts";
import { CliError } from "../errors.ts";
import { isRecord } from "../util.ts";
import type { GovernedFilesystem } from "./filesystem.ts";
import type { ProcessAuthority } from "./process.ts";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const LOG_RECORD_MAX = 64 * 1024;
const LOG_RECORD_COUNT_MAX = 4096;
const LOG_RPC_MAX = 256 * 1024;
const HISTORY_MAX = 256;
const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HISTORY_LOG_MEMORY_MAX = 32 * 1024 * 1024;
const SAFE_ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } as const;

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
export type JobSubmit = {
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

type PersistedJob = JobProjection & { fingerprint: string; daemonGeneration: string };
type ActiveJob = PersistedJob & {
  request?: JobSubmit;
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

function sanitizePersisted(value: unknown, expectedJobId: string): PersistedJob | null {
  if (!isRecord(value) || value.jobId !== expectedJobId || typeof value.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.fingerprint) || typeof value.daemonGeneration !== "string" ||
    typeof value.state !== "string" || !new Set(["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "unknown"]).has(value.state) ||
    typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || typeof value.cwd !== "string" ||
    !isRecord(value.command) || typeof value.command.executable !== "string" ||
    typeof value.command.argumentCount !== "number" || !Number.isSafeInteger(value.command.argumentCount) || typeof value.command.shell !== "boolean" ||
    (value.output !== "capture" && value.output !== "discard") || typeof value.runTimeoutMs !== "number" || !Number.isSafeInteger(value.runTimeoutMs) ||
    !isRecord(value.logs) || typeof value.logs.bytes !== "number" || !Number.isSafeInteger(value.logs.bytes) || value.logs.bytes < 0 ||
    typeof value.logs.nextOffset !== "number" || !Number.isSafeInteger(value.logs.nextOffset) || value.logs.nextOffset < 0 ||
    value.logs.bytes !== value.logs.nextOffset || typeof value.logs.truncated !== "boolean") return null;
  const optionalNumber = (key: "startedAt" | "finishedAt" | "exitCode") => value[key] === undefined || (typeof value[key] === "number" && Number.isSafeInteger(value[key]));
  if (!optionalNumber("startedAt") || !optionalNumber("finishedAt") || !optionalNumber("exitCode") ||
    (value.signal !== undefined && typeof value.signal !== "string") || (value.reason !== undefined && typeof value.reason !== "string") ||
    (value.cancelOperationId !== undefined && typeof value.cancelOperationId !== "string")) return null;
  return {
    jobId: expectedJobId, state: value.state as JobState, createdAt: value.createdAt,
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
    fingerprint: value.fingerprint, daemonGeneration: value.daemonGeneration,
  };
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
  ) {}

  static async create(
    configDir: string,
    authority: ProcessAuthority,
    filesystem: GovernedFilesystem,
    now: () => number,
    generation: string = randomUUID(),
    onLifecycle?: (event: JobLifecycleEvent) => void,
  ): Promise<JobManager> {
    const root = join(configDir, "jobs");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await syncDirectory(configDir);
    const manager = new JobManager(root, generation, authority, filesystem, now, onLifecycle);
    await manager.load();
    return manager;
  }

  capabilities(): string[] { return this.authority.capabilities(); }

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
      if (inspected >= 4096) break;
      inspected += 1;
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!JOB_ID.test(name)) continue;
      try {
        const statePath = join(this.root, name, "state.json");
        if ((await stat(statePath)).size > 64 * 1024) throw new Error("oversized state");
        const persisted = sanitizePersisted(JSON.parse(await readFile(statePath, "utf8")), name);
        if (!persisted) throw new Error("corrupt state");
        const recovered = persisted.state === "queued" || persisted.state === "running";
        if (recovered) {
          persisted.state = "unknown";
          persisted.finishedAt = this.now();
          persisted.reason = "daemon_restart";
        }
        const job: ActiveJob = {
          ...persisted, logEvents: [], logReservedBytes: persisted.logs.bytes, logReservedEvents: 0, logsLoaded: false,
          logQueue: Promise.resolve(), cancellationQueue: Promise.resolve(), waiters: new Set(),
        };
        this.jobs.set(name, job);
        await this.persist(job);
        if (recovered) this.emitLifecycle(job);
      } catch {
        const quarantined: ActiveJob = {
          jobId: name, state: "unknown", createdAt: this.now(), finishedAt: this.now(), cwd: "unknown:/",
          command: { executable: "unknown", argumentCount: 0, shell: false }, output: "discard", runTimeoutMs: 0,
          reason: "corrupt_state", logs: { bytes: 0, nextOffset: 0, truncated: true },
          fingerprint: createHash("sha256").update(`corrupt:${name}`).digest("hex"), daemonGeneration: this.generation,
          logEvents: [], logReservedBytes: 0, logReservedEvents: 0, logsLoaded: true,
          logQueue: Promise.resolve(), cancellationQueue: Promise.resolve(), waiters: new Set(),
        };
        this.jobs.set(name, quarantined);
        await this.persist(quarantined);
        this.emitLifecycle(quarantined);
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
        job.logs = { bytes: 0, nextOffset: 0, truncated: true };
        job.logReservedBytes = 0;
        job.logReservedEvents = 0;
        job.logsLoaded = true;
        await this.persist(job);
      }
    }
  }

  private async pruneHistory(): Promise<void> {
    const terminal = [...this.jobs.values()].filter((job) => this.terminal(job.state)).sort((a, b) => b.createdAt - a.createdAt);
    for (let index = 0; index < terminal.length; index += 1) {
      const job = terminal[index]!;
      if (index < HISTORY_MAX && this.now() - (job.finishedAt ?? job.createdAt) <= HISTORY_MAX_AGE_MS) continue;
      this.jobs.delete(job.jobId);
      await rm(join(this.root, job.jobId), { recursive: true, force: true });
    }
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

  private async loadLogs(jobId: string): Promise<JobLogEvent[]> {
    try {
      const path = join(this.root, jobId, "logs.ndjson");
      if ((await stat(path)).size > this.authority.policy.maxOutputBytes * 3 + 1024 * 1024) return [];
      let expectedOffset = 0;
      const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
      if (lines.length > LOG_RECORD_COUNT_MAX) return [];
      const events: JobLogEvent[] = [];
      for (const line of lines) {
        const value = JSON.parse(line) as unknown;
        if (!isRecord(value) || value.offset !== expectedOffset || typeof value.nextOffset !== "number" ||
          !Number.isSafeInteger(value.nextOffset) || value.nextOffset <= expectedOffset ||
          (value.stream !== "stdout" && value.stream !== "stderr") || typeof value.observedAt !== "number" ||
          typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > LOG_RECORD_MAX ||
          typeof value.contentBase64 !== "string" || !canonicalBase64(value.contentBase64, value.bytes) ||
          value.nextOffset !== value.offset + value.bytes) return [];
        expectedOffset = value.nextOffset;
        events.push(value as JobLogEvent);
      }
      return events;
    } catch { return []; }
  }

  private projection(job: ActiveJob): JobProjection {
    const { fingerprint: _fingerprint, daemonGeneration: _generation, request: _request, child: _child,
      timer: _timer, escalation: _escalation, leaderStartTime: _leaderStartTime, launching: _launching, logReservedBytes: _reserved,
      logReservedEvents: _reservedEvents, logsLoaded: _logsLoaded, cancelPersistence: _cancelPersistence,
      cancellationQueue: _cancellationQueue,
      terminalIntent: _intent, logEvents: _events,
      logQueue: _queue, waiters: _waiters, ...projection } = job;
    return projection;
  }

  private async persist(job: ActiveJob): Promise<void> {
    const dir = join(this.root, job.jobId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await syncDirectory(this.root);
    const path = join(dir, "state.json");
    const temporary = join(dir, `.state.${randomUUID()}.tmp`);
    const persisted: PersistedJob = { ...this.projection(job), fingerprint: job.fingerprint, daemonGeneration: job.daemonGeneration };
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
  }

  private async publishTerminal(job: ActiveJob): Promise<void> {
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

  async submit(request: JobSubmit): Promise<JobProjection> {
    const prior = this.admission;
    let release!: () => void;
    this.admission = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await this.submitAdmitted(request); }
    finally { release(); }
  }

  private async submitAdmitted(request: JobSubmit): Promise<JobProjection> {
    this.validate(request);
    const cwd = request.cwd ?? `${this.authority.policy.defaultCwdRoot}:/`;
    const executableName = request.shell ? "shell" : request.argv[0]!;
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...request, cwd })).digest("hex");
    const existing = this.jobs.get(request.jobId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CliError("job_conflict", "Job identity was reused with different input.");
      return this.projection(existing);
    }
    if (this.closing) throw new CliError("job_interrupted", "Job admission is closing.");
    await this.authority.executable(executableName, request.shell);
    const directory = await this.filesystem.executionDirectory(cwd, this.authority.policy.cwdRoots);
    await directory.close();
    if (this.closing) throw new CliError("job_interrupted", "Job admission is closing.");
    const nonterminal = [...this.jobs.values()].filter((job) => job.state === "queued" || job.state === "running").length;
    if (nonterminal >= this.authority.policy.maxConcurrent + this.authority.policy.maxQueued) {
      throw new CliError("job_conflict", "Job queue is full.");
    }
    const job: ActiveJob = {
      jobId: request.jobId, state: "queued", createdAt: this.now(), cwd,
      command: { executable: executableName, argumentCount: request.shell ? 1 : request.argv.length - 1, shell: request.shell },
      output: request.output, runTimeoutMs: request.runTimeoutMs,
      logs: { bytes: 0, nextOffset: 0, truncated: false },
      fingerprint, daemonGeneration: this.generation, request: { ...request, cwd },
      logEvents: [], logReservedBytes: 0, logReservedEvents: 0, logsLoaded: true,
      logQueue: Promise.resolve(), cancellationQueue: Promise.resolve(), waiters: new Set(),
    };
    this.jobs.set(job.jobId, job);
    try {
      await this.persist(job);
    } catch (error) {
      this.jobs.delete(job.jobId);
      await rm(join(this.root, job.jobId), { recursive: true, force: true }).catch(() => undefined);
      await syncDirectory(this.root).catch(() => undefined);
      throw error;
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
    job.reason ??= job.terminalIntent === "cancelled" ? "cancelled_before_spawn" : "daemon_shutdown";
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
        job.reason ??= "daemon_shutdown";
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

  list(states: readonly JobState[] = [], limit = 50): JobProjection[] {
    return [...this.jobs.values()].filter((job) => states.length === 0 || states.includes(job.state))
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
      if (bytes + event.bytes > limitBytes) break;
      events.push(event);
      bytes += event.bytes;
    }
    return {
      jobId, offset, nextOffset: events.at(-1)?.nextOffset ?? offset,
      events, state: job.state, complete: this.terminal(job.state) && (events.at(-1)?.nextOffset ?? offset) >= job.logs.nextOffset,
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
    const previousId = job.cancelOperationId;
    job.cancelOperationId = cancelOperationId;
    const pending = this.persist(job).then(() => {
      job.terminalIntent ??= "cancelled";
      if (job.child?.pid) this.terminateGroup(job, authorized);
    });
    job.cancelPersistence = pending;
    try {
      await pending;
    } catch (error) {
      if (job.cancelOperationId === cancelOperationId) job.cancelOperationId = previousId;
      throw error;
    } finally {
      if (job.cancelPersistence === pending) job.cancelPersistence = undefined;
    }
  }

  async cancel(jobId: string, cancelOperationId: string): Promise<JobProjection> {
    if (!JOB_ID.test(cancelOperationId)) throw new CliError("process_invalid", "Cancellation identity is invalid.");
    const job = this.jobs.get(jobId);
    if (!job) throw new CliError("job_not_found", "Job was not found.");
    const prior = job.cancellationQueue;
    let release!: () => void;
    job.cancellationQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      if (this.closing) throw new CliError("job_interrupted", "Job cancellation is closing.");
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
      const previous = { state: job.state, reason: job.reason, finishedAt: job.finishedAt, request: job.request, cancelOperationId: job.cancelOperationId };
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
          job.state = previous.state; job.reason = previous.reason; job.finishedAt = previous.finishedAt;
          job.request = previous.request; job.cancelOperationId = previous.cancelOperationId; job.terminalIntent = undefined;
          if (queuedIndex >= 0 && !this.queue.includes(job.jobId)) {
            this.queue.splice(Math.min(queuedIndex, this.queue.length), 0, job.jobId);
            void this.drain();
          }
          throw error;
        }
      })();
      job.cancelPersistence = persistence;
      try {
        await persistence;
      } finally {
        if (job.cancelPersistence === persistence) job.cancelPersistence = undefined;
      }
      this.notify(job); this.emitLifecycle(job); void this.pruneHistory();
      return this.projection(job);
    }
    if (job.state === "running") {
      await this.recordCancellation(job, cancelOperationId);
      if (job.state === "running" && !job.escalation) this.terminateGroup(job);
    }
    return this.projection(job);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.admission;
    await Promise.allSettled([...this.jobs.values()].map((job) => job.cancellationQueue));
    for (const job of this.jobs.values()) {
      if (job.state === "queued") {
        job.terminalIntent = "interrupted";
        job.reason = "daemon_shutdown";
        if (job.launching) {
          this.terminateGroup(job);
          await this.persist(job);
        } else {
          job.state = "interrupted"; job.finishedAt = this.now(); job.request = undefined;
          await this.publishTerminal(job);
        }
      } else if (job.state === "running") {
        job.terminalIntent = "interrupted"; this.terminateGroup(job);
      }
    }
    await Promise.allSettled([...this.launches]);
    await Promise.allSettled([...this.escalations]);
  }
}
