import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { ManagementClientError, UUID, JOB_STATES, normalizeJobStart, normalizeJobCancel, jobIdentity,
  type JobStart, type JobView, type JobPage, type JobPolicyView, type JobLogPage, type JobCancelReceipt, type Capability } from "@grokbox/client/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { JobManager, ProcessAuthority, GovernedFilesystem, HostResourceError, openConfigStore, rootConfigLayout,
  readJobRecord, listJobRecords, readJobLogs, jobRequestFingerprint, type JobStoredRecord, type JobSubmit, type HostFilesystemRoot } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";

function failure(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ManagementClientError) return new HttpFailure(error.code === "wrong_installation" ? 409 : 400, error.code, error.message);
  if (error instanceof HostResourceError) {
    if (error.code === "job_not_found") return new HttpFailure(404, "not_found", "The original Job was not found for this principal.");
    if (error.code === "job_conflict" || error.code === "fs_conflict") return new HttpFailure(409, "idempotency_conflict", "The Job identity or execution owner conflicts with this request. Inspect its original receipt.");
    if (error.code === "operation_outcome_unknown") return new HttpFailure(409, "operation_unknown", "Job admission may have committed. Read the original request without submitting replacement work.");
    if (error.code === "process_forbidden" || error.code === "fs_forbidden") return new HttpFailure(403, "permission_denied", "The execution or working-directory policy does not permit this request.");
    if (error.code === "process_invalid" || error.code === "fs_path_invalid") return new HttpFailure(400, "invalid_input", "The Job input, cursor or limits are invalid.");
  }
  return new HttpFailure(503, "source_unavailable", "The Job source or execution authority is unavailable. No history was replaced and no fallback executor was selected.");
}
const io = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
const checked = <A>(run: () => A) => Effect.try({ try: run, catch: failure });
const terminal = (state: string) => !["queued", "running"].includes(state);
export function jobRequestId(installationId: string, principalId: string, requestId: string): string {
  const b = createHash("sha256").update(canonicalJson(["managed-job-v1", installationId, principalId, requestId])).digest();
  b[6] = (b[6]! & 15) | 128; b[8] = (b[8]! & 63) | 128;
  const h = b.subarray(0,16).toString("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function policyInput(root: string) {
  const value = (await openConfigStore(rootConfigLayout(root)).read()).document.daemon;
  return { process: value?.process ?? null, roots: (value?.filesystem?.roots ?? []) as HostFilesystemRoot[] };
}
type PolicyInput = Awaited<ReturnType<typeof policyInput>>;

/** One management-service acquisition of the original OS/Job owner. No per-RPC
 * manager, detached service, new database or second scheduling loop. */
export class JobService {
  readonly generation = randomUUID();
  readonly lifetime = new AbortController();
  private manager?: JobManager;
  private filesystem?: GovernedFilesystem;
  private captured?: PolicyInput;
  private configurationDigest?: string;
  private closed = false;
  private closePromise?: Promise<void>;
  private constructor(readonly root: string, readonly installationId: string) {}
  static async acquire(root: string, installationId: string) {
    const service = new JobService(root, installationId);
    try {
      service.captured = await policyInput(root);
      service.configurationDigest = sha256Text(canonicalJson(service.captured));
      if (service.captured.process) {
        service.filesystem = await GovernedFilesystem.create(service.captured.roots, Date.now);
        const authority = await ProcessAuthority.create(service.captured.process);
        service.manager = await JobManager.create(root, authority, service.filesystem, Date.now, service.generation);
      }
    } catch {
      // Other management domains and retained reads remain available. A competing
      // or damaged Job owner is not repaired or started through another path.
      await service.filesystem?.close(); service.filesystem = undefined;
    }
    return service;
  }
  async policy(): Promise<JobPolicyView> {
    const common = { serviceGeneration: this.generation, roots: [], executables: [], environment: [], shellAllowed: false,
      defaultCwdRoot: null, limits: null, revision: null, filesystemSandbox: false } as const;
    let current: PolicyInput;
    try { current = await policyInput(this.root); } catch { return { ...common, roots: [], executables: [], environment: [], state: "unavailable" }; }
    const absent = (state: JobPolicyView["state"]): JobPolicyView => ({ ...common, roots: [], executables: [], environment: [], state });
    if (this.closed) return absent("unavailable");
    if (sha256Text(canonicalJson(current)) !== this.configurationDigest) return absent("restart-required");
    if (!current.process) return absent("unconfigured");
    if (!this.manager) return absent("unavailable");
    const p = current.process;
    return { state: "ready", revision: sha256Text(canonicalJson(["job-policy-v1", this.installationId, this.generation, current])),
      serviceGeneration: this.generation, roots: [...p.cwdRoots], defaultCwdRoot: p.defaultCwdRoot,
      executables: p.executables.map(e => e.name), environment: [...p.environment], shellAllowed: !!p.shell,
      limits: { maxConcurrent: p.maxConcurrent, maxQueued: p.maxQueued, maxRuntimeMs: p.maxRuntimeMs, maxOutputBytes: p.maxOutputBytes, safetyRecords: 4096 }, filesystemSandbox: false };
  }
  private owns(row: JobStoredRecord, principal: Principal) {
    return row.scope?.installationId === this.installationId && row.scope.principalId === principal.id;
  }
  async record(id: string, principal: Principal): Promise<JobStoredRecord> {
    const row = this.closed ? await readJobRecord(this.root, id) : await this.manager?.stableRecord(id) ?? await readJobRecord(this.root, id);
    if (!row || !this.owns(row, principal)) throw new HttpFailure(404, "not_found", "The original Job was not found for this principal.");
    return row;
  }
  view(row: JobStoredRecord): JobView {
    if (!row.scope) throw new HttpFailure(503,"source_unavailable","The Job has no current management identity.");
    const current = !this.closed && !!this.manager && row.serviceGeneration === this.generation;
    return { version: 1, jobRef: `job:${this.installationId}:${row.jobId}`, requestId: row.scope.requestId, policyRevision: row.scope.policyRevision,
      state: !current && !terminal(row.state) ? "unknown" : row.state, observation: current ? "current-service" : "retained-record",
      createdAt: row.createdAt, startedAt: row.startedAt ?? null, finishedAt: row.finishedAt ?? null, cwd: row.cwd, command: row.command,
      output: row.output, runTimeoutMs: row.runTimeoutMs, exitCode: row.exitCode ?? null, signal: row.signal ?? null,
      reason: !current && !terminal(row.state) ? "owner_not_observed" : row.reason ?? null, cancelOperationId: row.cancelOperationId ?? null,
      logs: row.logs, effectsReverted: false };
  }
  async get(id: string, principal: Principal, waitMs = 0, signal?: AbortSignal): Promise<JobView> {
    const row = await this.record(id, principal);
    if (waitMs && this.manager && row.serviceGeneration === this.generation) await this.manager.waitTerminal(id, waitMs, signal);
    return this.view(await this.record(id, principal));
  }
  async list(principal: Principal, limit: number, cursor: string | null): Promise<JobPage> {
    // Enumerate immutable identities from the active owner; reopening all of its
    // files while it atomically publishes can turn a normal transition into a
    // false read failure. Cold/borrowed history still uses the strict disk reader.
    const records = this.manager && !this.closed
      ? this.manager.list([], 4096, { installationId: this.installationId, principalId: principal.id })
      : (await listJobRecords(this.root)).filter(row => this.owns(row, principal));
    const owner = sha256Text(canonicalJson([this.installationId, principal.id]));
    let lastTime = Number.MAX_SAFE_INTEGER, lastId = "";
    if (cursor) {
      const parts = cursor.split(":");
      if (parts.length !== 3 || parts[0] !== owner || !/^[1-9][0-9]*$/.test(parts[1]!) || !Number.isSafeInteger(Number(parts[1])) || !UUID.test(parts[2]!)) throw new HttpFailure(409,"cursor_gap","Use the original principal-bound Job cursor.");
      lastTime = Number(parts[1]); lastId = parts[2]!;
    }
    const selected = records.filter(r => r.createdAt < lastTime || r.createdAt === lastTime && r.jobId > lastId)
      .sort((a,b) => b.createdAt-a.createdAt || a.jobId.localeCompare(b.jobId));
    const page = selected.slice(0,limit), last = page.at(-1), jobs: JobView[] = [];
    for (const row of page) jobs.push(this.view(await this.record(row.jobId, principal)));
    return { jobs, nextCursor: selected.length > limit && last ? `${owner}:${last.createdAt}:${last.jobId}` : null, coverage: "retained-principal-records" };
  }
  async start(request: JobStart, principal: Principal, authorize: (signal: AbortSignal, capability: Capability) => Promise<void>) {
    const id = jobRequestId(this.installationId, principal.id, request.requestId);
    const previous = await this.manager?.stableRecord(id) ?? await readJobRecord(this.root,id);
    const submit = (cwd: string): JobSubmit & { cwd: string } => ({ jobId: id, scope: { installationId: this.installationId, principalId: principal.id,
      requestId: request.requestId, policyRevision: request.expectedRevision }, argv: request.argv, environment: request.environment,
      cwd, runTimeoutMs: request.runTimeoutMs, output: request.output, shell: request.shell });
    if (previous) {
      if (!this.owns(previous,principal) || previous.fingerprint !== jobRequestFingerprint(submit(request.cwd ?? previous.cwd))) throw new HttpFailure(409,"idempotency_conflict","The original Job request has different immutable input.");
      return this.view(previous);
    }
    const policy = await this.policy();
    if (policy.state !== "ready" || policy.revision !== request.expectedRevision || !this.manager) throw new HttpFailure(409,"revision_conflict","Review the current service's Job policy before new work.");
    const authority = async () => {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10000)]);
      signal.throwIfAborted();
      await authorize(signal,"jobs.start"); if (request.shell) await authorize(signal,"jobs.shell");
      const latest = await this.policy();
      if (latest.state !== "ready" || latest.revision !== request.expectedRevision) throw new HostResourceError("process_forbidden","Job policy changed before process dispatch.");
      signal.throwIfAborted();
    };
    await this.manager.submit(submit(request.cwd ?? `${policy.defaultCwdRoot}:/`), authority);
    return this.get(id,principal);
  }
  async logs(id: string, principal: Principal, offset: number, maxBytes: number, waitMs: number, signal?: AbortSignal): Promise<JobLogPage> {
    const row = await this.record(id,principal);
    const result = this.manager ? await this.manager.logsRead(id,offset,maxBytes,waitMs,signal) : await readJobLogs(this.root,id,offset,maxBytes);
    const { jobId: _id, ...page } = result;
    return { ...page, state: this.view(await this.record(id,principal)).state, jobRef: `job:${this.installationId}:${row.jobId}` };
  }
  async cancellation(id: string, requestId: string, principal: Principal): Promise<JobCancelReceipt> {
    const job = await this.get(id,principal);
    if (job.cancelOperationId !== requestId) throw new HttpFailure(404,"not_found","No cancellation receipt matches this Job and original request.");
    return { version:1, requestId, jobRef:job.jobRef, cancelOperationId:requestId, state:job.state === "unknown" || job.reason === "cancel_persistence_unknown" ? "unknown" : terminal(job.state) ? "settled" : "requested", job, effectsReverted:false };
  }
  async cancel(id: string, requestId: string, principal: Principal, authorize: (signal: AbortSignal, cap: Capability) => Promise<void>) {
    const row = await this.record(id,principal);
    if (row.cancelOperationId === requestId) return this.cancellation(id,requestId,principal);
    if (row.cancelOperationId || terminal(this.view(row).state)) throw new HttpFailure(409,"idempotency_conflict","Read the existing cancellation or terminal Job; a new cancel cannot prove old effects absent.");
    if (!this.manager || row.serviceGeneration !== this.generation) throw new HttpFailure(409,"operation_unknown","This service does not own the original process and will not signal a guessed PID.");
    await this.manager.cancel(id,requestId,() => authorize(AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(10000)]),"jobs.cancel"));
    return this.cancellation(id,requestId,principal);
  }
  close(): Promise<void> {
    this.closed=true; this.lifetime.abort();
    return this.closePromise ??= (async () => { try { await this.manager?.close(); } finally { await this.filesystem?.close(); } })();
  }
}
export type JobDomain = { service: JobService; authorize: (signal: AbortSignal, capability: Capability) => Promise<void> };
function bounded(url: URL, key: string, fallback: number, max: number) {
  const text=url.searchParams.get(key); if(text===null)return fallback;
  if(!/^(0|[1-9][0-9]*)$/.test(text)||!Number.isSafeInteger(Number(text))||Number(text)>max)throw new HttpFailure(400,"invalid_input","Invalid Job read bound.");
  return Number(text);
}
/** Submitted work is service-owned; request fibers only own admission and reads. */
export function jobApplication(domain: JobDomain, principal: Principal, method: string, url: URL, input?: unknown) {
  const s=domain.service;
  return Effect.gen(function*(){
    const path=url.pathname, isLogs=/\/logs$/.test(path), operation=path.startsWith("/v1/job-operations/")||path.startsWith("/v1/job-cancellations/");
    const capability: Capability=method==="POST"?path==="/v1/job-starts"?"jobs.start":"jobs.cancel":operation?"operations.read":isLogs?"jobs.logs.read":"jobs.read";
    yield* checked(()=>{requireCapability(principal,capability); const keys=path==="/v1/jobs"?["limit","cursor"]:isLogs?["offset","limitBytes","waitMs"]:/^\/v1\/jobs\/[^/]+$/.test(path)?["waitMs"]:[];
      for(const key of url.searchParams.keys())if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)throw new HttpFailure(400,"invalid_input","Unsupported Job query.");});
    if(method==="GET"&&path==="/v1/job-policy")return yield* io(()=>s.policy());
    if(method==="GET"&&path==="/v1/jobs")return yield* io(()=>s.list(principal,Math.max(1,bounded(url,"limit",25,100)),url.searchParams.get("cursor")));
    const request=/^\/v1\/job-operations\/([0-9a-f-]{36})$/.exec(path), cancel=/^\/v1\/job-cancellations\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(path);
    if(method==="GET"&&request&&UUID.test(request[1]!))return yield* io(()=>s.get(jobRequestId(s.installationId,principal.id,request[1]!),principal));
    if(method==="GET"&&cancel&&UUID.test(cancel[1]!)&&UUID.test(cancel[2]!))return yield* io(()=>s.cancellation(cancel[1]!,cancel[2]!,principal));
    const target=/^\/v1\/jobs\/([^/]+)(\/logs)?$/.exec(path);
    if(method==="GET"&&target){
      const id=yield* checked(()=>jobIdentity(decodeURIComponent(target[1]!),s.installationId).id);
      return yield* io<JobLogPage | JobView>(signal=>target[2]?s.logs(id,principal,bounded(url,"offset",0,67108864),bounded(url,"limitBytes",65536,65536),bounded(url,"waitMs",0,25000),signal):s.get(id,principal,bounded(url,"waitMs",0,25000),signal));
    }
    if(method==="POST"&&(path==="/v1/job-starts"||path==="/v1/job-cancellations")) {
      const task=path==="/v1/job-starts"?()=>s.start(normalizeJobStart(input),principal,domain.authorize):()=>{const r=normalizeJobCancel(input,s.installationId);return s.cancel(jobIdentity(r.jobRef,s.installationId).id,r.requestId,principal,domain.authorize);};
      // Only bounded admission/publication waits here; the manager owns execution
      // and is acquired/released by the parent management Effect Scope.
      return yield* Effect.uninterruptible(io<JobView | JobCancelReceipt>(task));
    }
    return yield* Effect.fail(new HttpFailure(404,"not_found","Unsupported Job endpoint."));
  });
}
