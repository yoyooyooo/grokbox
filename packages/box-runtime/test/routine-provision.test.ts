import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runRoutineProvisionCommand, type RoutineProvisionNative } from "../src/internal/roots/routine-provision.runtime.ts";
import { openRoutineProvisionStore, type ProvisionStoreHooks } from "../src/internal/io/routine-provision.node.ts";
import { maintainObservationStorage } from "../src/internal/io/storage-maintenance.node.ts";
import { observeRuntimeStorage } from "../src/internal/roots/storage-maintenance.runtime.ts";
import { parseRoutineBlueprint, projectNativeRoutines, observedRoutineDefinitionDigest, desiredRoutineDigest, provisionFingerprint,
  ROUTINE_PROVISION_POLICY, type ProvisionObservation, type RoutineProvisionCommand } from "@grokbox/runtime-kernel/routines";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blueprint = parseRoutineBlueprint({ schemaVersion: 1, key: "notice", name: "Runtime notices", prompt: "PRIVATE_PROMPT_SENTINEL", trigger: { type: "webhook" } });
function apply(operationId = "initial", prompt = blueprint.prompt): RoutineProvisionCommand {
  return { action: "apply", agentId: AGENT, operationId, confirmed: true, blueprint: { ...blueprint, prompt } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "routine-provision-")); let writes = 0, reads = 0;
  let rows: Record<string, unknown>[] = [], lost = false, generation = "same";
  const observe = (): ProvisionObservation => ({ catalog: projectNativeRoutines(AGENT, rows), generation,
    definitions: new Map(rows.filter(r => r.isEnabled === false).map(r => [String(r.id), observedRoutineDefinitionDigest({ name: r.name, prompt: r.prompt, trigger: r.trigger, isEnabled: r.isEnabled })])) });
  const native: RoutineProvisionNative = {
    list: async () => { reads++; return observe(); },
    write: async (_id, b, id) => {
      writes++;
      const next = { id: id ?? `native-${writes}`, name: b.name, prompt: b.prompt, trigger: b.trigger, isEnabled: b.isEnabled, createdAt: 100 };
      if (id) rows = rows.map(r => r.id === id ? next : r); else rows.push(next);
      if (lost) throw Error("PRIVATE_LOST_ACK"); return observe();
    },
  };
  return { root, native, observe, writes: () => writes, reads: () => reads, rows: () => rows,
    lose: (value = true) => { lost = value; }, changeGeneration: () => { generation = "other"; },
    run: (command: RoutineProvisionCommand, hooks?: ProvisionStoreHooks) => runRoutineProvisionCommand({ durableRoot: root, command, native, hooks }),
    store: () => openRoutineProvisionStore(root), close: () => rm(root, { recursive: true, force: true }) };
}

test("explicit creation defaults disabled; same operation across reopen returns the stored ID with no new native call", async () => {
  const f = await fixture(); try {
    const result = await f.run(apply());
    expect(result).toMatchObject({ state: "disabled_definition_observed", action: "create", routineId: "native-1", automaticEnable: false, nativeIdempotency: false });
    expect(f.rows()[0]!.isEnabled).toBe(false); expect(f.writes()).toBe(1);
    const readBefore = f.reads(); expect(await f.run(apply())).toEqual(result); expect(f.reads()).toBe(readBefore); expect(f.writes()).toBe(1);
    expect(await f.run({ action: "outcome", agentId: AGENT, operationId: "initial" })).toEqual(result);
    await expect(f.run({ action: "reconcile", agentId: AGENT, operationId: "initial", routineId: "wrong-id", confirmed: true })).rejects.toMatchObject({ reason: "operation_conflict" });
    const bytes = await readFile(f.store().path); expect(bytes.includes(Buffer.from(blueprint.prompt))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  } finally { await f.close(); }
});

test("same nonce with altered content conflicts, and a managed key update keeps the exact native ID", async () => {
  const f = await fixture(); try {
    const first = await f.run(apply());
    await expect(f.run(apply("initial", "different"))).rejects.toMatchObject({ reason: "operation_conflict" });
    await expect(f.run(apply("update", "different"))).rejects.toMatchObject({ reason: "revision_conflict" });
    const command = apply("update", "different"); if (command.action !== "apply") throw Error("fixture");
    const second = await f.run({ ...command, expectedRevision: first.revision! });
    expect(second).toMatchObject({ state: "disabled_definition_observed", action: "update", routineId: "native-1" });
    expect(f.writes()).toBe(2); expect(f.rows()).toHaveLength(1); expect(f.rows()[0]!.prompt).toBe("different");
    expect(await f.run(apply())).toEqual(first);
  } finally { await f.close(); }
});

test("lost create reply blocks both replay and new IDs for the same key until explicit exact-ID reconciliation", async () => {
  const f = await fixture(); try {
    f.lose(); const unknown = await f.run(apply());
    expect(unknown.state).toBe("outcome_unknown"); expect(f.writes()).toBe(1);
    f.lose(false); expect((await f.run(apply())).state).toBe("outcome_unknown"); expect(f.writes()).toBe(1);
    await expect(f.run(apply("different-id"))).rejects.toMatchObject({ reason: "key_busy" });
    await expect(f.run({ action: "reconcile", agentId: AGENT, operationId: "initial", routineId: "wrong", confirmed: true })).rejects.toBeDefined();
    const settled = await f.run({ action: "reconcile", agentId: AGENT, operationId: "initial", routineId: "native-1", confirmed: true });
    expect(settled.state).toBe("disabled_definition_observed"); expect(f.writes()).toBe(1);
    expect(await f.run(apply())).toEqual(settled);
  } finally { await f.close(); }
});

test("concurrent operations cannot both pass the same managed-key dispatch reservation", async () => {
  const f = await fixture(); try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => f.run(apply(`parallel-${i}`))));
    expect(results.some(r => r.status === "fulfilled")).toBe(true); expect(f.writes()).toBe(1); expect(f.rows()).toHaveLength(1);
  } finally { await f.close(); }
});

test("committed reservation with lost acknowledgement never grants a second dispatch and live-owner reconciliation is refused", async () => {
  const f = await fixture(); try {
    await expect(f.run(apply(), { afterReserve: () => { throw Error("lost_local_reservation_ack"); } })).rejects.toBeDefined();
    expect(f.writes()).toBe(0);
    expect((await f.run(apply())).state).toBe("outcome_unknown");
    await expect(f.run({ action: "reconcile", agentId: AGENT, operationId: "initial", routineId: "native-1", confirmed: true })).rejects.toMatchObject({ reason: "key_busy" });
    expect(f.writes()).toBe(0);
  } finally { await f.close(); }
});

for (const phase of ["beforeFinish", "afterFinish"] as const) test(`${phase} failure never repeats native creation, and stored outcome remains inspectable`, async () => {
  const f = await fixture(); try {
    expect((await f.run(apply(), { [phase]: () => { throw Error("fixture_local_commit_failure"); } })).state).toBe("outcome_unknown");
    const prior = await f.run({ action: "outcome", agentId: AGENT, operationId: "initial" });
    expect(prior.state).toBe(phase === "afterFinish" ? "disabled_definition_observed" : "outcome_unknown");
    expect(f.writes()).toBe(1); await f.run(apply()); expect(f.writes()).toBe(1);
  } finally { await f.close(); }
});

test("hundreds of settled updates shrink to exact tombstones, while current binding and unknown creation remain protected", async () => {
  const f = await fixture();
  try {
    let last = await f.run(apply());
    f.lose();
    const pending = apply("pending-create"); if (pending.action !== "apply") throw Error("fixture");
    expect((await f.run({ ...pending, blueprint: { ...pending.blueprint, key: "pending" } })).state).toBe("outcome_unknown");
    f.lose(false);
    for (let n = 0; n < 300; n++) {
      const next = apply(`update-${n}`, `finite-definition-${n}`); if (next.action !== "apply") throw Error("fixture");
      last = await f.run({ ...next, expectedRevision: last.revision! });
      expect(last.state).toBe("disabled_definition_observed");
    }
    const beforeWrites = f.writes(), beforeReads = f.reads();
    expect(await f.run(apply())).toMatchObject({ state: "retired", automaticRetry: false, durableReplayGuard: true });
    expect((await f.run({ action: "outcome", agentId: AGENT, operationId: "initial" })).state).toBe("retired");
    await expect(f.run(apply("initial", "altered"))).rejects.toMatchObject({ reason: "operation_conflict" });
    expect(f.writes()).toBe(beforeWrites); expect(f.reads()).toBe(beforeReads);
    expect(await f.store().status()).toMatchObject({ operations: 3, unresolved: 1, retiredOperations: 299 });
    expect((await stat(f.store().path)).size).toBeLessThanOrEqual(ROUTINE_PROVISION_POLICY.maxDatabaseBytes);
    const binding = await f.store().binding(AGENT, "notice"); expect(binding?.operationId).toBe("update-299");
    expect((await f.store().read(AGENT, "pending-create"))?.state).toBe("unknown");
    expect(f.rows()).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);

test("pure outcome queries do not create a store; invalid inputs and unsafe paths produce no remote effect", async () => {
  const f = await fixture(); try {
    expect((await f.run({ action: "outcome", agentId: AGENT, operationId: "missing" })).state).toBe("not_recorded");
    expect(await readdir(f.root)).toEqual([]);
    await expect(runRoutineProvisionCommand({ durableRoot: f.root, native: f.native, command: { ...apply(), confirmed: false } })).rejects.toBeDefined();
    expect(f.reads()).toBe(0); expect(f.writes()).toBe(0); expect(await readdir(f.root)).toEqual([]);
    const victim = join(f.root, "victim"); await writeFile(victim, "USER_DATA"); await symlink(victim, join(f.root, "state"));
    await expect(f.run(apply())).rejects.toBeDefined(); expect(f.writes()).toBe(0); expect(await readFile(victim, "utf8")).toBe("USER_DATA");
  } finally { await f.close(); }
});

test("truncated or missing existing ledgers are never reset into a new permission to create", async () => {
  const f = await fixture(); try {
    await f.run(apply()); const path = f.store().path;
    await writeFile(path, "", { mode: 0o600 });
    await expect(f.run(apply("after-truncate"))).rejects.toMatchObject({ reason: "ledger_unavailable" });
    expect((await stat(path)).size).toBe(0); expect(f.writes()).toBe(1);
    await rm(path);
    await expect(f.run(apply("after-missing"))).rejects.toMatchObject({ reason: "ledger_unavailable" });
    expect(f.writes()).toBe(1); expect(await stat(path).catch(() => null)).toBeNull();
  } finally { await f.close(); }
});

test("diagnostic maintenance cannot expire a provisioning guard; status accounts for this separate safety owner", async () => {
  const f = await fixture(); try {
    f.lose(); await f.run(apply()); const before = await readFile(f.store().path);
    await maintainObservationStorage({ durableRoot: f.root, runRoot: f.root, nowMs: Date.now() + 90 * 86400000 });
    expect(await readFile(f.store().path)).toEqual(before);
    const status = await observeRuntimeStorage({ durableRoot: f.root });
    expect(status.routineProvision).toMatchObject({ owner: "routine_provision", state: "measured", operations: 1, unresolved: 1, diagnosticGcAllowed: false });
    expect((await f.run(apply())).state).toBe("outcome_unknown"); expect(f.writes()).toBe(1);
  } finally { await f.close(); }
});

test("finite operation capacity refuses new dispatch without evicting unknown guards or storing prompts", async () => {
  const f = await fixture(); try {
    const store = f.store();
    for (let i = 0; i < ROUTINE_PROVISION_POLICY.maxOperations; i++) {
      const c = apply(`reserve-${i}`); if (c.action !== "apply") throw Error("fixture");
      c.blueprint = { ...c.blueprint, key: `key-${i}` };
      await store.reserve({ agentId: AGENT, operationId: c.operationId, key: c.blueprint.key, action: "create", binding: null,
        fingerprint: provisionFingerprint(c), desiredDigest: desiredRoutineDigest(c.blueprint), atMs: Date.now() });
    }
    await expect(f.run(apply("overflow"))).rejects.toMatchObject({ reason: "capacity" }); expect(f.writes()).toBe(0);
    expect((await stat(store.path)).size).toBeLessThanOrEqual(ROUTINE_PROVISION_POLICY.maxDatabaseBytes);
    expect((await store.read(AGENT, "reserve-0"))?.state).toBe("attempting");
    expect((await readFile(store.path)).includes(Buffer.from(blueprint.prompt))).toBe(false);
  } finally { await f.close(); }
}, 30000);

test("SIGKILL after durable reserve preserves the no-replay guard; only explicit dead-owner reconciliation releases it", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/routine-provision-reserve-worker.ts", import.meta.url)), f.root],
    { env: { PATH: process.env.PATH, HOME: f.root }, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("owned_reserve_deadline")); }, 5000);
      child.once("error", e => { clearTimeout(timer); reject(e); });
      let output = "";
      child.stdout.on("data", data => { output += data; if (output.includes("reserved")) { clearTimeout(timer); resolve(); } });
      child.once("close", () => { clearTimeout(timer); if (!output.includes("reserved")) reject(Error("owned_reserve_failed")); });
    });
    await f.native.write(AGENT, blueprint, null);
    expect((await f.run(apply())).state).toBe("outcome_unknown"); expect(f.writes()).toBe(1);
    await expect(f.run({ action: "reconcile", agentId: AGENT, operationId: "initial", routineId: "native-1", confirmed: true })).rejects.toMatchObject({ reason: "key_busy" });
    child.kill("SIGKILL"); await exit;
    const observed = await f.run({ action: "reconcile", agentId: AGENT, operationId: "initial", routineId: "native-1", confirmed: true });
    expect(observed.state).toBe("disabled_definition_observed"); expect(f.writes()).toBe(1);
    expect(await f.run(apply())).toEqual(observed);
  } finally { child.kill("SIGKILL"); await exit; await f.close(); }
}, 10000);

test("unsupported triggers, automatic enable and unbounded bodies are rejected locally", () => {
  for (const patch of [{ isEnabled: true }, { trigger: { type: "cron", schedule: "" } }, { prompt: "x".repeat(20000) }, { name: " padded " }, { secret: "PRIVATE" }]) {
    expect(() => parseRoutineBlueprint({ ...blueprint, ...patch })).toThrow();
  }
});
