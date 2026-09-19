import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { BindingFailure, projectProviderRecoveryState, parseContextReceipt, CONTEXT_FAILURE_CODES, type ContextMaintenanceRecord, type ContextSelectionCapture } from "@grokbox/runtime-kernel/contract";
import { captureContextPolicy } from "@grokbox/runtime-kernel/config";
import { parseResolvedModelSelection, computeSelectionRevision } from "@grokbox/runtime-kernel/selection";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import type { ColdTurn, ExecutionHistory, ExecutionHistoryHealth, LedgerRecord } from "@grokbox/runtime-kernel/inference";
import type { ClassicLevel } from "classic-level";
import { admitExecutionWrite, retireExecutionBatch } from "./execution-retirement.node.ts";

const fail = () => new BindingFailure("ledger_unavailable");
const digest = (value: unknown) => typeof value === "string" && (value === "" || /^[a-f0-9]{64}$/.test(value));
function stepRecord(value: unknown): LedgerRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const v = value as Record<string, unknown>;
  if (!digest(v.snapshotDigest) || !digest(v.selectionRevision)
    || !["active", "terminal", "rejected", "cancelled"].includes(String(v.status))
    || (v.bindingId !== undefined && !digest(v.bindingId))
    || Object.keys(v).some(k => !["snapshotDigest", "selectionRevision", "bindingId", "status", "recovery"].includes(k))) throw fail();
  if (v.recovery !== undefined) {
    const checked = projectProviderRecoveryState(v.recovery);
    if (!checked || canonicalJson(checked) !== canonicalJson(v.recovery)) throw fail();
  }
  return v as LedgerRecord;
}
function turnRecord(value: unknown): ColdTurn | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const v = value as ColdTurn;
  if (v.version !== 1 || !v.turn || typeof v.turn.serviceEpoch !== "string"
    || !["open", "revoked", "closed"].includes(v.turn.lifecycle) || typeof v.turn.expired !== "boolean"
    || !Number.isFinite(v.turn.lastActivityMs)) throw fail();
  if (v.binding && (!digest(v.binding.bindingId) || !v.binding.model || !v.binding.selection
    || !v.binding.ownership || typeof v.binding.fingerprint !== "string" || "lease" in v.binding)) throw fail();
  if (v.binding) {
    try {
      const model = parseResolvedModelSelection(v.binding.model);
      if (v.binding.selection.agentId !== v.binding.agentId || v.binding.selection.modelId !== model.id
        || computeSelectionRevision({ agentId: v.binding.agentId, model }) !== v.binding.selection.selectionRevision) throw fail();
      v.binding.model = model;
    } catch { throw fail(); }
  }
  return v;
}

function contextSelectionRecord(value: unknown): ContextSelectionCapture | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const v = value as ContextSelectionCapture;
  if (v.version !== 1 || Object.keys(v).some(k => !["version", "hostEpoch", "serviceEpoch", "agentId", "turnId", "selection", "model", "policy", "authFingerprint"].includes(k))
    || typeof v.agentId !== "string" || typeof v.turnId !== "string" || !v.selection || !v.policy || !v.hostEpoch || !v.serviceEpoch) throw fail();
  try {
    const model = parseResolvedModelSelection(v.model);
    const policy = captureContextPolicy({ windowTokens: v.policy.windowTokens, compaction: v.policy.compaction }, model.id, v.agentId);
    if (canonicalJson(policy) !== canonicalJson(v.policy) || v.selection.agentId !== v.agentId || v.selection.modelId !== model.id
      || computeSelectionRevision({ agentId: v.agentId, model }) !== v.selection.selectionRevision) throw fail();
    if (v.authFingerprint !== undefined && (typeof v.authFingerprint !== "string" || !v.authFingerprint
      || v.authFingerprint.length > 256 || /[\x00-\x1f]/.test(v.authFingerprint))) throw fail();
    if (JSON.stringify(v).length > 65536) throw fail();
    return { ...v, model, policy };
  } catch { throw fail(); }
}

function maintenanceRecord(value: unknown): ContextMaintenanceRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const v = value as ContextMaintenanceRecord;
  const allowed = ["fingerprint", "identity", "state", "summaryRequests", "summaryInputTokens", "failure", "receipt", "updatedAtMs", "detailsRetired"];
  if (Object.keys(v).some(key => !allowed.includes(key)) || !digest(v.fingerprint) || !v.fingerprint
    || !["claimed", "summarizing", "committing", "committed", "failed", "commit_unknown"].includes(v.state)
    || !Number.isSafeInteger(v.summaryRequests) || v.summaryRequests < 0 || v.summaryRequests > 64
    || !Number.isSafeInteger(v.summaryInputTokens) || v.summaryInputTokens < 0 || v.summaryInputTokens > 16777216
    || (v.failure !== undefined && !CONTEXT_FAILURE_CODES.includes(v.failure)) || !v.identity
    || (v.updatedAtMs !== undefined && (!Number.isSafeInteger(v.updatedAtMs) || v.updatedAtMs < 0))) throw fail();
  if (v.detailsRetired !== undefined && (v.detailsRetired !== true || !["committed", "failed"].includes(v.state) || v.receipt !== undefined)) throw fail();
  const id = v.identity;
  if (Object.keys(id).some(key => !["operationId", "hostEpoch", "serviceEpoch", "agentId", "sessionId", "rootId", "rootRevision", "selection", "parent"].includes(key))) throw fail();
  for (const key of ["operationId", "agentId", "rootId", "rootRevision"] as const) {
    if (typeof id[key] !== "string" || !id[key] || id[key].length > 256 || /[\x00-\x1f]/.test(id[key])) throw fail();
  }
  if (typeof id.sessionId !== "string" || id.sessionId.length > 256 || !id.hostEpoch || !id.serviceEpoch || !id.selection) throw fail();
  if (Object.keys(id.hostEpoch).some(key => !["compile", "source", "profile", "hostIdentity", "bridgeDigest", "wireVersion"].includes(key))
    || Object.values(id.hostEpoch).some(item => typeof item !== "string" || item.length > 256)
    || Object.keys(id.serviceEpoch).some(key => key !== "incarnationId") || typeof id.serviceEpoch.incarnationId !== "string"
    || Object.keys(id.selection).some(key => !["agentId", "modelId", "selectionRevision"].includes(key))
    || Object.values(id.selection).some(item => typeof item !== "string" || item.length > 256)) throw fail();
  if (id.parent && (Object.keys(id.parent).some(key => !["turnId", "stepId", "bindingId"].includes(key))
    || Object.values(id.parent).some(item => typeof item !== "string" || item.length > 256))) throw fail();
  if (v.receipt) {
    const r = parseContextReceipt(v.receipt);
    if (r.sourceRootRevision !== id.rootRevision || r.summaryRequests !== v.summaryRequests || r.summaryInputTokens !== v.summaryInputTokens) throw fail();
    if (Object.keys(r).some(key => !["operationId", "rootId", "sourceRootRevision", "rootRevision", "outcome", "policyRevision", "budget", "before", "after", "summaryRequests", "summaryInputTokens", "targetMet", "headroomMet", "persisted"].includes(key))
      || r.operationId !== id.operationId || r.rootId !== id.rootId || !["unchanged", "committed"].includes(r.outcome)
      || typeof r.persisted !== "boolean" || !r.budget || !r.before || !r.after) throw fail();
    const budgetKeys = ["policyRevision", "mode", "declaredWindowTokens", "localWindowTokens", "windowTokens", "outputTokens", "reserveTokens", "inputTokens", "preferredTargetTokens", "resumeThresholdTokens", "keepRecentTokens"];
    if (Object.keys(r.budget).some(key => !budgetKeys.includes(key))) throw fail();
    for (const m of [r.before, r.after]) {
      if (Object.keys(m).some(key => !["method", "meterVersion", "tokens", "estimatedTokens", "uncertaintyTokens", "bytes", "messageCount", "components"].includes(key))
        || !m.components || Object.keys(m.components).some(key => !["system", "messages", "tools"].includes(key))) throw fail();
    }
  }
  if (JSON.stringify(v).length > 32768) throw fail();
  return v;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
  await chmod(path, 0o700);
}

/** The LevelDB lock is the one writer owner for this root. A new incarnation
 * first retires the old index while exclusively locked, then publishes its epoch
 * before the Unix listener starts. Old epoch requests cannot pass the kernel.
 * No live record-count ceiling, no full-database JS heap load, no JSON/image
 * rewrite per STEP. LevelDB handles block caching and incremental compaction. */
export function openExecutionHistory(runRoot: string, serviceEpoch: string) {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await privateDirectory(runRoot);
        await privateDirectory(join(runRoot, "state"));
        const path = join(runRoot, "state", "modeld-execution");
        await privateDirectory(path);
        const { ClassicLevel } = await import("classic-level");
        const db = new ClassicLevel<string, unknown>(path, { valueEncoding: "json", writeBufferSize: 4 * 1024 * 1024, maxFileSize: 2 * 1024 * 1024 });
        try {
          await db.open(); // LEVEL_LOCKED refuses a competing writer; never delete its lock.
          const previous = await db.get("!service-epoch");
          if (previous === serviceEpoch) throw fail(); // Restart must get a new incarnation.
          if (previous !== undefined) {
            // STEP/TURN authority is incarnation-local. Maintenance claims must
            // survive an unknown commit ack so a restart cannot replay summaries.
            await db.clear({ lt: "c!" });
            await db.clear({ gte: "d!" });
            await db.compactRange("\u0000", "\uffff");
          }
          await db.put("!service-epoch", serviceEpoch, { sync: true });
          return db;
        } catch (error) { await db.close().catch(() => undefined); throw error; }
      },
      catch: fail,
    }),
    db => Effect.promise(() => db.close()),
  ).pipe(Effect.map(db => historyAdapter(db, join(runRoot, "state", "modeld-execution"))));
}

function historyAdapter(db: ClassicLevel<string, unknown>, path: string): ExecutionHistory {
  // One queue belongs to the LevelDB owner. GC cannot race a claim/settlement,
  // and every queued Promise is awaited by its caller before Scope release.
  let writesSettled: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = writesSettled.then(run, run); writesSettled = next.catch(() => undefined); return next;
  };
  const admit = (value: unknown) => admitExecutionWrite(path, Buffer.byteLength(JSON.stringify(value)));
  const closed = (turn: ColdTurn | undefined) => turn && turn.turn.lifecycle !== "open";
  const stepTurnHash = (key: string): string | null => {
    try { const id = JSON.parse(key); return id && typeof id.host === "string" && typeof id.agentId === "string" && typeof id.turnId === "string"
      ? sha256Text(canonicalJson({ host: id.host, agentId: id.agentId, turnId: id.turnId })) : null; } catch { return null; }
  };
  const state: ExecutionHistoryHealth = { kind: "leveldb", available: true, reads: 0, writes: 0, failures: 0, lastError: null };
  // A successful read does not prove that a previously failed write can now
  // commit a new identity claim (for example after ENOSPC). Recover each side
  // only on an actually successful operation on that side.
  const failed = { read: false, write: false };
  const ioTiming = { readMs: 0, writeMs: 0 };
  const io = <T>(side: "read" | "write", operation: () => Promise<T>) => {
    const effect = Effect.tryPromise({
    try: async () => {
      const started = performance.now();
      try {
        const result = await (side === "write" ? serialized(operation) : operation());
        failed[side] = false;
        state.available = !failed.read && !failed.write;
        state.lastError = state.available ? null : "storage_unavailable";
        return result;
      } finally {
        ioTiming[side === "read" ? "readMs" : "writeMs"] += Math.max(0, performance.now() - started);
      }
    },
    catch: error => { failed[side] = true; state.available = false; state.failures++; state.lastError = "storage_unavailable";
      return error instanceof BindingFailure ? error : fail(); },
    });
    // Cancellation waits for an admitted/queued batch. Scope release must never
    // close LevelDB while an abandoned Promise can later publish a claim.
    return side === "write" ? Effect.uninterruptible(effect) : effect;
  };
  return {
    getContextSelection: key => io("read", async () => { state.reads++; return contextSelectionRecord(await db.get(`p!${sha256Text(key)}`)); }),
    putContextSelection: (key, value) => io("write", async () => {
      const checked = contextSelectionRecord(value); if (!checked) throw fail();
      await admit(checked);
      await db.put(`p!${sha256Text(key)}`, checked, { sync: true }); state.writes++;
    }),
    getStep: key => io("read", async () => { state.reads++; return stepRecord(await db.get(`s!${sha256Text(key)}`)); }),
    putStep: (key, value) => io("write", async () => {
      const checked = stepRecord(value);
      if (!checked) throw fail();
      const parent = stepTurnHash(key), previous = parent ? turnRecord(await db.get(`t!${parent}`)) : undefined;
      if (closed(previous) && await db.get(`s!${sha256Text(key)}`) === undefined) {
        if (checked.status === "active") throw new BindingFailure("cancelled");
        return; // Late settlement cannot resurrect an already retired child.
      }
      await admit(checked);
      await db.put(`s!${sha256Text(key)}`, checked, { sync: true }); state.writes++;
    }),
    getTurn: key => io("read", async () => { state.reads++; return turnRecord(await db.get(`t!${sha256Text(key)}`)); }),
    putTurn: (key, value) => io("write", async () => {
      const checked = turnRecord(value);
      if (!checked) throw fail();
      const hash = sha256Text(key), previous = turnRecord(await db.get(`t!${hash}`));
      if (closed(previous) && checked.turn.lifecycle === "open") throw new BindingFailure("cancelled");
      await admit(checked);
      await db.batch<string, unknown>([
        { type: "put", key: `t!${hash}`, value: checked },
        ...(closed(checked) ? [{ type: "put" as const, key: `r!${hash}`, value: true }] : []),
      ], { sync: true }); state.writes++;
    }),
    putIdentity: input => io("write", async () => {
      const step = stepRecord(input.step), turn = turnRecord(input.turn);
      if (!step || !turn) throw fail();
      if (closed(turnRecord(await db.get(`t!${sha256Text(input.turnKey)}`)))) throw new BindingFailure("cancelled");
      await admit({ step, turn });
      await db.batch<string, unknown>([
        { type: "put", key: `s!${sha256Text(input.stepKey)}`, value: step },
        { type: "put", key: `t!${sha256Text(input.turnKey)}`, value: turn },
        { type: "put", key: `x!${sha256Text(input.turnKey)}!${sha256Text(input.stepKey)}`, value: true },
      ], { sync: true });
      state.writes += 2;
    }),
    getMaintenance: key => io("read", async () => { state.reads++; return maintenanceRecord(await db.get(`c!${sha256Text(key)}`)); }),
    getLatestMaintenance: (agentId, sessionId) => io("read", async () => {
      state.reads++;
      const value = maintenanceRecord(await db.get(`c-latest!${sha256Text(canonicalJson([agentId, sessionId]))}`));
      if (value && (value.identity.agentId !== agentId || value.identity.sessionId !== sessionId)) throw fail();
      return value;
    }),
    putMaintenance: (key, value) => io("write", async () => {
      const checked = maintenanceRecord(value); if (!checked || checked.detailsRetired) throw fail();
      const currentKey = `c!${sha256Text(key)}`;
      if (maintenanceRecord(await db.get(currentKey))?.detailsRetired) throw new BindingFailure("cancelled");
      const latestKey = `c-latest!${sha256Text(canonicalJson([checked.identity.agentId, checked.identity.sessionId]))}`;
      const previous = maintenanceRecord(await db.get(latestKey));
      const changes: Array<{ type: "put"; key: string; value: unknown }> = [
        { type: "put", key: currentKey, value: checked }, { type: "put", key: latestKey, value: checked },
      ];
      if (previous && previous.identity.operationId !== checked.identity.operationId && ["committed", "failed"].includes(previous.state)) {
        const priorKey = `c!${sha256Text(canonicalJson([previous.identity.agentId, previous.identity.sessionId, previous.identity.operationId]))}`;
        const retained = maintenanceRecord(await db.get(priorKey));
        if (retained?.fingerprint === previous.fingerprint && !retained.detailsRetired) {
          const { receipt: _receipt, ...guard } = retained;
          changes.push({ type: "put", key: priorKey, value: { ...guard, detailsRetired: true } });
        }
      }
      await admit(changes);
      await db.batch<string, unknown>(changes, { sync: true }); state.writes += 2;
    }),
    maintain: () => io("write", async () => {
      const receipt = await retireExecutionBatch(db, path); state.retention = receipt; return receipt;
    }),
    health: () => ({ ...state, ioTiming: { ...ioTiming } }),
  };
}
