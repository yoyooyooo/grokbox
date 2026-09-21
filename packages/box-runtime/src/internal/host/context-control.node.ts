import { ContextFailure, contextFailure, decideManagedOwnership, WIRE_VERSION, parseContextManualApproval, type ContextMaintenanceReceipt, type ContextManualApproval, type ContextFailureCode } from "@grokbox/runtime-kernel/contract";
import { requestModeld } from "./modeld-client.node.ts";
import { captureHostManagedSelection } from "./selection.node.ts";
import { hostContextClient, type HostContextClientOptions } from "./context-client.node.ts";

export const HOST_CONTEXT_CONTROL_SYMBOL = "grokbox.box-runtime.context-control.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OP = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
type Native = Record<string, unknown>;
const record = (value: unknown): value is Native => value !== null && typeof value === "object" && !Array.isArray(value);
function invoke(target: Native, name: string): unknown {
  const method = target[name];
  if (typeof method !== "function") throw new ContextFailure("capability_unqualified");
  return Reflect.apply(method, target, []);
}
type Shell = { host: Native; agentId: string; sessionId: string; run: (prompt: string, options?: Native) => Promise<unknown>;
  busy: () => boolean; interrupt: (reason: string) => unknown; normalRuns: number; manual?: Job;
  maintenanceBlock?: "commit_unknown" | "native_cleanup_unknown" };
type Job = { operationId: string; shell: Shell; options: Native; approval: ContextManualApproval; promise: Promise<unknown>; receipt?: ContextMaintenanceReceipt; settlement: "running" | "returned" | "failed" | "unknown"; failureCode?: ContextFailureCode };

/** One finite native operation facade. The existing runner still creates the
 * context, reloads/persists state and owns cancellation. A trusted WeakMap flag
 * chooses its native summarize action, never a hidden user prompt or fake STEP. */
export function createHostContextControl(options: HostContextClientOptions & { durableRoot: string }) {
  const shells = new Map<string, WeakRef<Shell>>();
  const flags = new WeakMap<object, Job>();
  const jobs = new Map<string, Job>();
  const nativeClient = hostContextClient(options);
  const shellKey = (agentId: string, sessionId: string) => JSON.stringify([agentId, sessionId]);
  const isCurrent = (shell: Shell) => shells.get(shellKey(shell.agentId, shell.sessionId))?.deref() === shell;
  const wrapRun = (host: unknown, run: unknown, busy: unknown, interrupt: unknown) => {
    if (!record(host) || typeof run !== "function" || typeof busy !== "function" || typeof interrupt !== "function" || options.mode !== "route") return run;
    let shell: Shell | undefined;
    const register = () => {
      if (host.isSubagentRunner === true) return;
      const agentId = invoke(host, "getConversationId"), transcriptId = invoke(host, "getTranscriptId");
      // This native shell is qualified only for the original default Box session.
      // Named/server/subagent sessions must not be silently mapped to it.
      if (typeof agentId !== "string" || !UUID.test(agentId) || transcriptId !== agentId) return;
      if (shell && isCurrent(shell)) return;
      const key = shellKey(agentId, "");
      if (shells.size >= 256 && !shells.has(key)) {
        for (const [id, ref] of shells) if (!ref.deref()) shells.delete(id);
        if (shells.size >= 256) return;
      }
      const prior = shells.get(key)?.deref();
      if (prior?.manual) prior.interrupt("context owner replaced");
      shell = { host, agentId, sessionId: "", run: (prompt, args) => Reflect.apply(run, undefined, [prompt, args]),
        busy: () => Reflect.apply(busy, undefined, []) === true,
        interrupt: reason => Reflect.apply(interrupt, undefined, [reason]), normalRuns: 0 };
      shells.set(key, new WeakRef(shell));
    };
    try { register(); } catch { /* Native construction may precede identity initialization. */ }
    return async (prompt: string, args?: Native) => {
      try { register(); } catch { /* Unsupported shells remain on their unchanged native path. */ }
      const owner = shell;
      // A genuine new user run waits for maintenance; it is not consumed by it.
      // Normal native runs retain their existing supersession semantics.
      if (owner?.manual) await owner.manual.promise.catch(error => {
        const failure = contextFailure(error, "commit_unknown");
        // A safely failed summary can be followed by a new user intent. An
        // uncertain native write/cleanup cannot: do not automatically consume
        // queued input against a partially replaced or still-owned root.
        if (failure.code === "commit_unknown" || failure.code === "native_cleanup_unknown") throw failure;
      });
      if (owner?.maintenanceBlock) throw new ContextFailure(owner.maintenanceBlock);
      if (owner) owner.normalRuns++;
      try { return await Reflect.apply(run, undefined, [prompt, args]); }
      finally { if (owner) owner.normalRuns--; }
    };
  };
  const manualOptions = (host: unknown, value: unknown) => {
    if (!record(value)) return undefined;
    const job = flags.get(value);
    return job && job.shell.host === host && job.shell.manual === job && isCurrent(job.shell)
      ? { operationId: job.operationId } : undefined;
  };
  const manualAction = (raw: unknown): Promise<unknown> | undefined => {
    if (!record(raw) || typeof raw.turnId !== "string" || typeof raw.agentId !== "string") return undefined;
    const job = jobs.get(raw.turnId);
    if (!job || job.shell.agentId !== raw.agentId || job.shell.manual !== job || !isCurrent(job.shell)) return undefined;
    return (async () => {
      const capture = typeof raw.capture === "function" ? await Reflect.apply(raw.capture, undefined, []) : raw;
      if (!record(capture) || capture.agentId !== raw.agentId || capture.turnId !== raw.turnId) throw new ContextFailure("not_admitted");
      const client = nativeClient(capture, () => job.shell.manual === job && isCurrent(job.shell), { operationId: job.operationId, approval: job.approval });
      if (!client?.manual) throw new ContextFailure("capability_unqualified");
      job.receipt = await client.manual();
      return { handled: true, receipt: job.receipt };
    })();
  };
  const status = async (agentId: string, sessionId: string, operationId?: string) => {
    const frame = (await requestModeld(options.runRoot, { version: WIRE_VERSION, method: "context-status", agentId, sessionId,
      ...(operationId ? { operationId } : {}) }, 10000))[0];
    if (!record(frame) || frame.ok !== true || !record(frame.data)) throw new ContextFailure("capability_unqualified");
    return frame.data;
  };
  const call = async (raw: unknown, readOwnership?: () => Promise<unknown>): Promise<unknown> => {
    let refusedBeforeDispatch: string | undefined;
    try {
      if (!record(raw) || Object.keys(raw).some(key => !["action", "agentId", "sessionId", "operationId", "confirm", "approval"].includes(key))
        || !["status", "compact"].includes(String(raw.action)) || typeof raw.agentId !== "string" || !UUID.test(raw.agentId)
        || raw.sessionId !== undefined && (typeof raw.sessionId !== "string" || raw.sessionId.length > 128 || /[\x00-\x1f]/.test(raw.sessionId))
        || raw.operationId !== undefined && (typeof raw.operationId !== "string" || !OP.test(raw.operationId))) throw new ContextFailure("context_material_invalid");
      const agentId = raw.agentId, sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
      const shell = shells.get(shellKey(agentId, sessionId))?.deref();
      const report = await status(agentId, sessionId, typeof raw.operationId === "string" ? raw.operationId : undefined);
      const selected = captureHostManagedSelection(options.durableRoot, agentId);
      if (raw.action === "status") return { ok: true, data: { ...report,
        queriedOperationId: typeof raw.operationId === "string" ? raw.operationId : null,
        hostGeneration: options.binding?.generationId ?? null,
        selectionRevision: selected.kind === "managed" ? selected.selectionRevision : null,
        operationSettlement: typeof raw.operationId === "string" ? jobs.get(raw.operationId)?.shell.agentId === agentId ? jobs.get(raw.operationId)!.settlement : "not-retained" : "not-requested",
        operationFailure: typeof raw.operationId === "string" && jobs.get(raw.operationId)?.shell.agentId === agentId ? jobs.get(raw.operationId)!.failureCode ?? null : null,
        nativeCapability: shell && isCurrent(shell) ? shell.maintenanceBlock ? "blocked" : shell.busy() || shell.normalRuns > 0 || shell.manual ? "busy" : "ready" : "unavailable",
        nativeBlockReason: shell && isCurrent(shell) ? shell.maintenanceBlock ?? null : null,
        capabilityScope: "loaded-default-box-session" } };
      if (options.mode !== "route" || raw.confirm !== true || typeof raw.operationId !== "string" || !readOwnership) throw new ContextFailure("not_admitted");
      if (typeof raw.approval !== "string" || raw.approval.length > 1024) throw new ContextFailure("not_admitted");
      const approval = parseContextManualApproval(JSON.parse(raw.approval));
      if (selected.kind !== "managed" || approval.selectionRevision !== selected.selectionRevision
        || approval.hostGeneration !== options.binding?.generationId) throw new ContextFailure("not_admitted");
      const proof = await readOwnership();
      const decision = decideManagedOwnership({ agentId, snapshot: record(proof) ? proof.grokboxOwnership : undefined, nowMs: Date.now() });
      if (!decision.ok || decision.evidence.scopeId !== approval.scopeId) throw new ContextFailure("not_admitted");
      const old = jobs.get(raw.operationId);
      if (old) {
        if (old.shell !== shell) throw new ContextFailure("maintenance_conflict");
        return await old.promise;
      }
      if (record(report.lastMaintenance)) {
        const prior = report.lastMaintenance;
        if (record(prior.receipt) && prior.state === "committed") return { ok: true, data: { ...report, duplicate: true, nativeCurrent: false } };
        throw new ContextFailure("commit_unknown");
      }
      // Only this exact invocation, after excluding every retained original,
      // can directly certify that no native job was started. A later missing
      // status/record is never such a certificate.
      refusedBeforeDispatch = raw.operationId;
      if (!shell || !isCurrent(shell)) throw new ContextFailure("capability_unqualified");
      if (shell.maintenanceBlock) throw new ContextFailure(shell.maintenanceBlock);
      if (shell.manual || shell.normalRuns > 0 || shell.busy()) throw new ContextFailure("maintenance_busy");
      const state = invoke(shell.host, "getConversationState");
      if (!record(state) || !Array.isArray(state.rootPromptMessagesJson) || !Array.isArray(state.pendingToolCalls)
        || state.pendingToolCalls.length > 0) throw new ContextFailure("maintenance_busy");
      for (const [id, job] of jobs) if (job.shell.manual !== job && jobs.size >= 128) jobs.delete(id);
      if (jobs.size >= 128) throw new ContextFailure("maintenance_busy");
      const runOptions: Native = { hidden: true, isSilenceAllowed: true, inferenceRequestId: raw.operationId,
        advanceChainOnDelivery: false, autoReviewEpoch: "continue" };
      const job: Job = { operationId: raw.operationId, shell, options: runOptions, approval, settlement: "running", promise: undefined as unknown as Promise<unknown> };
      flags.set(runOptions, job); shell.manual = job; jobs.set(job.operationId, job); refusedBeforeDispatch = undefined;
      job.promise = Promise.resolve().then(async () => {
        const timer = setTimeout(() => { if (shell.manual === job && isCurrent(shell)) shell.interrupt("context maintenance deadline"); }, 150000);
        try {
          const currentSelection = captureHostManagedSelection(options.durableRoot, agentId);
          if (currentSelection.kind !== "managed" || currentSelection.selectionRevision !== approval.selectionRevision) throw new ContextFailure("not_admitted");
          await shell.run("", runOptions);
          if (!job.receipt) throw new ContextFailure("commit_unknown");
          job.settlement = "returned";
          return { ok: true, data: { operationId: job.operationId, receipt: job.receipt, duplicate: false } };
        } catch (error) {
          const failure = contextFailure(error, "commit_unknown");
          job.failureCode = failure.code;
          job.settlement = failure.code === "commit_unknown" || failure.code === "native_cleanup_unknown" ? "unknown" : "failed";
          if (isCurrent(shell) && (failure.code === "commit_unknown" || failure.code === "native_cleanup_unknown")) {
            // Dropping job.manual is not proof that this mutable root is usable.
            // Retain a local safety block until the native owner is reloaded or
            // independently reconciled; changing the operation ID cannot clear it.
            shell.maintenanceBlock = failure.code;
          }
          throw failure;
        } finally { clearTimeout(timer); flags.delete(runOptions); if (shell.manual === job) shell.manual = undefined; }
      });
      return await job.promise;
    } catch (error) { return { ok: false, error: { code: contextFailure(error, "capability_unqualified").code },
      ...(refusedBeforeDispatch && !jobs.has(refusedBeforeDispatch) ? { operationId: refusedBeforeDispatch, hostGeneration: options.binding?.generationId ?? null, nativeSettlement: "not-started" } : {}) }; }
  };
  return { wrapRun, manualOptions, manualAction, call };
}
