import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { readDiagnosticPoolPolicy } from "./journal-policy.node.ts";
import { observeDiagnosticFootprint } from "./diagnostic-footprint.node.ts";
import { withJournalLock } from "./journal-lock.node.ts";

const MIB = 1024 * 1024, METADATA_ALLOWANCE = MIB;
const FORMAT = "grokbox.diagnostic-admission", SCOPE_BYTES = 1024;
export type DiagnosticBudgetReason = "pressure" | "busy" | "scope_changed" | "policy_unavailable" | "inventory_incomplete" | "unsafe_state" | "growth_contract";
export class DiagnosticBudgetError extends Error {
  readonly code: string;
  constructor(readonly reason: DiagnosticBudgetReason) { super(`diagnostic_budget_${reason}`); this.name = "DiagnosticBudgetError"; this.code = `diagnostic_budget_${reason}`; }
}
export type DiagnosticWriter = "monitor" | "monitor-initialize" | "journal" | "process";
export type DiagnosticAdmission = {
  configurationRoot: string; sourceRoot: string; writer: DiagnosticWriter;
  /** Main database cap or finite maximum new bytes (including record/index/header).
   * Only source-owned adapters supply this, never an event or public CLI field. */
  maxBytes: number;
  maintenance?: boolean;
};
type Scope = { schemaVersion: 1; format: typeof FORMAT; rootId: string; runRootId: string };
const fail = (reason: DiagnosticBudgetReason): never => { throw new DiagnosticBudgetError(reason); };
const absent = (e: unknown) => e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT";
const stateDir = (root: string) => join(root, "state", "diagnostic-admission");
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
async function directory(path: string, create = false) {
  let created = false;
  if (create) try { await mkdir(path, { mode: 0o700 }); created = true; } catch (e) { if (!(e && typeof e === "object" && "code" in e && e.code === "EEXIST")) throw e; }
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || process.getuid && st.uid !== process.getuid()) return fail("unsafe_state");
  if (create && (st.mode & 0o077) !== 0) return fail("unsafe_state");
  return created;
}
async function readScope(root: string): Promise<Scope | null> {
  let fd;
  try {
    await directory(root); await directory(join(root, "state")); await directory(stateDir(root));
    fd = await open(join(stateDir(root), "scope.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > SCOPE_BYTES || (before.mode & 0o077) !== 0
      || process.getuid && before.uid !== process.getuid()) return fail("unsafe_state");
    const bytes = Buffer.alloc(SCOPE_BYTES + 1), read = await fd.read(bytes, 0, bytes.length, 0);
    const after = await fd.stat(), current = await lstat(join(stateDir(root), "scope.json"));
    if (read.bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) return fail("unsafe_state");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read.bytesRead)));
    if (!value || value.schemaVersion !== 1 || value.format !== FORMAT || !hash(value.rootId) || !hash(value.runRootId)
      || Object.keys(value).some(k => !["schemaVersion", "format", "rootId", "runRootId"].includes(k))) return fail("unsafe_state");
    return value as Scope;
  } catch (e) { if (absent(e)) return null; throw e instanceof DiagnosticBudgetError ? e : new DiagnosticBudgetError("unsafe_state"); }
  finally { await fd?.close(); }
}
async function bindScope(root: string, runRoot: string, mayInitialize: boolean) {
  const expected: Scope = { schemaVersion: 1, format: FORMAT, rootId: sha256Text(root), runRootId: sha256Text(runRoot) };
  const previous = await readScope(root);
  if (previous) {
    if (previous.rootId !== expected.rootId || previous.runRootId !== expected.runRootId) return fail("scope_changed");
    return;
  }
  if (!mayInitialize) return fail("unsafe_state");
  // Exclusive creation under the cross-writer lock. A torn first scope remains
  // invalid and is never erased/reinitialized to grant a fresh budget.
  const file = await open(join(stateDir(root), "scope.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(expected) + "\n"); await file.sync(); } finally { await file.close(); }
  const parent = await open(stateDir(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
async function checkMetadataBound(root: string) {
  const pending = [{ path: stateDir(root), depth: 0 }]; let charged = 0, entries = 0;
  while (pending.length) {
    if (++entries > 132) return fail("unsafe_state");
    const entry = pending.pop()!;
    const info = await lstat(entry.path).catch(e => { if (absent(e) && entry.path.includes(`${stateDir(root)}/events.prepare-`)) return null; throw e; });
    if (!info) continue;
    if (info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) return fail("unsafe_state");
    charged += Math.max(info.isFile() ? info.size : 0, info.blocks * 512);
    if (!Number.isSafeInteger(charged) || charged > METADATA_ALLOWANCE) return fail("pressure");
    if (info.isFile()) { if (info.nlink !== 1 || info.size > 4096) return fail("unsafe_state"); continue; }
    if (!info.isDirectory() || entry.depth > 1) return fail("unsafe_state");
    const directory = await opendir(entry.path).catch(e => { if (absent(e) && entry.path.includes(`${stateDir(root)}/events.prepare-`)) return null; throw e; });
    if (!directory) continue;
    try {
      for (;;) {
        const child = await directory.read(); if (!child) break;
        if (entries + pending.length >= 132) return fail("unsafe_state");
        if (entry.depth === 0 && child.name !== "scope.json" && child.name !== "writers.lock" && !/^events\.prepare-(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(child.name)) return fail("unsafe_state");
        pending.push({ path: join(entry.path, child.name), depth: entry.depth + 1 });
      }
    } finally { await directory.close(); }
  }
}
async function policy(root: string) {
  try { return await readDiagnosticPoolPolicy(root); }
  catch (e) { throw e instanceof DiagnosticBudgetError ? e : new DiagnosticBudgetError("policy_unavailable"); }
}
async function additionalBytes(input: DiagnosticAdmission, root: string) {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 || input.maxBytes > 128 * MIB) return fail("growth_contract");
  if (input.writer === "monitor" || input.writer === "monitor-initialize") {
    let current = 0;
    try {
      const info = await lstat(join(root, "observability", "observations.sqlite"));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return fail("unsafe_state");
      current = info.size;
    } catch (e) { if (!absent(e)) throw e; }
    // Main-file cap plus worst rollback journal and record/page overhead; an
    // explicit migration can also create a complete retained backup. This is
    // deliberately conservative, not live-page or row-count accounting.
    const auxiliary = Math.ceil(input.maxBytes * 1.02) + 64 * 1024;
    return Math.max(0, input.maxBytes - current) + auxiliary + (input.writer === "monitor-initialize" ? current + 64 * 1024 : 0);
  }
  if (input.writer === "process" && input.maintenance && input.maxBytes === 0) return 0;
  return Math.ceil(input.maxBytes / 4096) * 4096 + 64 * 1024;
}

/** Cooperating diagnostic writers share one finite, crash-recoverable filesystem
 * gate BEFORE their own database/journal locks. No database-backed second ledger,
 * background task, allocation by Bot, arbitrary cleanup or query-time mutation.
 * The original writer still owns its format, cap and rollback/unknown result.
 * External user data and uninstrumented/legacy writers are not an OS quota. */
export async function withDiagnosticAdmission<T>(input: DiagnosticAdmission, run: () => Promise<T>): Promise<T> {
  if (!isAbsolute(input.configurationRoot) || !isAbsolute(input.sourceRoot)
    || !["monitor", "monitor-initialize", "journal", "process"].includes(input.writer)) return fail("scope_changed");
  const root = resolve(input.configurationRoot), source = resolve(input.sourceRoot);
  const initial = await policy(root), prior = await readScope(root);
  if (!initial) {
    const existing = await lstat(stateDir(root)).then(() => true, e => { if (absent(e)) return false; throw e; });
    if (prior || existing) return fail("policy_unavailable");
    return run(); // Uninstalled legacy/local fixtures retain explicitly local caps.
  }
  if (source !== root && source !== initial.runRoot) return fail("scope_changed");
  await directory(root); await directory(join(root, "state"), true);
  const mayInitialize = await directory(stateDir(root), true);
  try {
    return await withJournalLock(join(stateDir(root), "writers.lock"), async () => {
      const selected = await policy(root);
      if (!selected || selected.runRoot !== initial.runRoot) return fail("scope_changed");
      await bindScope(root, selected.runRoot, mayInitialize);
      await checkMetadataBound(root);
      if ((input.writer === "monitor" || input.writer === "monitor-initialize") && input.maxBytes > selected.retention.monitor.maxBytes) return fail("policy_unavailable");
      const measured = await observeDiagnosticFootprint({ durableRoot: root, runRoot: selected.runRoot });
      if (measured.state !== "measured") return fail("inventory_incomplete");
      const charge = Math.max(measured.fileBytes, measured.allocatedBytes) + METADATA_ALLOWANCE;
      const reserve = await additionalBytes(input, root);
      const limit = selected.diagnostics.maxBytes - (input.maintenance ? 0 : selected.diagnostics.reserveBytes);
      if (reserve > 0 && charge + reserve > limit) return fail("pressure");
      // Other applications can consume the filesystem. Check available blocks
      // on both explicit roots; do not treat the application pool as disk free.
      for (const path of new Set([root, selected.runRoot])) {
        const fs = await statfs(path);
        const available = fs.bavail * fs.bsize;
        if (!Number.isSafeInteger(available) || available < reserve + selected.diagnostics.reserveBytes) return fail("pressure");
      }
      return run();
    }, input.maintenance ? 1 : 100);
  } catch (e) {
    if (e instanceof DiagnosticBudgetError) throw e;
    if (e && typeof e === "object" && "code" in e && (String(e.code).includes("BUSY") || e.code === "LOCK_TIMEOUT")) return fail("busy");
    throw e;
  }
}

/** Read-only policy/scope evidence. It never fabricates adoption by old binaries
 * or full-installation enforcement from a matching configuration alone. */
export async function observeDiagnosticAdmission(root: string) {
  try {
    const selected = await policy(resolve(root)), scope = await readScope(resolve(root));
    return { state: !selected ? scope ? "policy_unavailable" : "not_configured" : !scope ? "not_observed"
      : scope.rootId === sha256Text(resolve(root)) && scope.runRootId === sha256Text(selected.runRoot) ? "scope_bound" : "scope_changed",
      policyRevision: selected?.revision ?? null, scope: "cooperating_diagnostic_writers", mechanism: "serialized_reservation_before_effect",
      writers: ["monitor", "monitor-initialize", "journal", "process"], fixedMetadataAllowanceBytes: METADATA_ALLOWANCE,
      osFilesystemQuota: false, allRunningWritersVerified: false, installationBudgetEnforced: false };
  } catch { return { state: "unavailable", scope: "cooperating_diagnostic_writers", installationBudgetEnforced: false }; }
}
