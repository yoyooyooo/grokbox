import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireConfigurationLease } from "../src/internal/io/config-lock.node.ts";
import { observeRuntimeStorage } from "../src/internal/roots/storage-maintenance.runtime.ts";
import { pairingPlan } from "@grokbox/runtime-kernel/observation";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { nativeAutomationIdentity, validatePairingCredential, type PairingCommand, type PairingPlan } from "@grokbox/runtime-kernel/observation";
import { projectNativeRoutines, observedRoutineDefinitionDigest, parseRoutineBlueprint } from "@grokbox/runtime-kernel/routines";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openOpsBindings } from "../src/internal/io/ops-bindings.node.ts";
import { runRoutineProvisionCommand } from "../src/internal/roots/routine-provision.runtime.ts";
import { runOpsPairing, observeOpsTargets, revokeOpsTarget, type NativePairingSource } from "../src/internal/roots/ops-pairing.runtime.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", GENERATION = "a".repeat(64), KEY = "PRIVATE_PAIRING_KEY", PROMPT = "PRIVATE_PAIRING_PROMPT";
export async function pairingFixture() {
  const root = await mkdtemp(join(tmpdir(), "ops-pairing-test-"));
  const config = validateConfig({ ...defaultConfig(), ops: { enabled: false, notifications: { mode: "off" }, targets: { default: { agentId: AGENT, routineKey: "notice" } } } });
  await writeFile(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
  await openMonitorStore(root).initialize();
  const row: Record<string, unknown> = { id: "managed-notice", name: "Ops", prompt: PROMPT, trigger: { type: "webhook" }, isEnabled: false, createdAt: 100 };
  const snapshot = () => ({ catalog: projectNativeRoutines(AGENT, [row]), generation: GENERATION,
    definitions: new Map([[String(row.id), observedRoutineDefinitionDigest({ name: row.name, prompt: row.prompt, trigger: row.trigger, isEnabled: row.isEnabled })]]) });
  const blueprint = parseRoutineBlueprint({ schemaVersion: 1, key: "notice", name: "Ops", prompt: PROMPT, trigger: { type: "webhook" } });
  let created = false;
  const provisioned = await runRoutineProvisionCommand({ durableRoot: root, command: { action: "apply", agentId: AGENT, operationId: "provision", blueprint, confirmed: true }, native: {
    list: async () => created ? snapshot() : { ...snapshot(), catalog: projectNativeRoutines(AGENT, []), definitions: new Map() },
    write: async () => { created = true; return snapshot(); },
  } });
  let calls = 0, reads = 0; let credentialHook: (() => Promise<void>) | undefined;
  const native: NativePairingSource = { list: async () => { reads++; return snapshot(); }, credential: async () => {
    calls++; await credentialHook?.(); return { value: { url: `https://fixture.invalid/automations/webhook/${nativeAutomationIdentity(AGENT, String(row.id))}`, key: KEY }, generation: GENERATION };
  } };
  const command: PairingCommand = { action: "bind", alias: "default", routineId: String(row.id), expectedRevision: provisioned.revision!, operationId: "bind-one", confirmed: true };
  return { root, config, row, native, command, store: openOpsBindings(root), calls: () => calls, reads: () => reads,
    hook: (fn: () => Promise<void>) => { credentialHook = fn; },
    run: (cmd = command, expectedBindingRevision = 0) => runOpsPairing({ durableRoot: root, command: cmd, native, expectedBindingRevision }),
    close: () => rm(root, { recursive: true, force: true }) };
}

test("preview only reads, bind stores a private key without enabling, and repeated operation does not mint again", async () => {
  const f = await pairingFixture(); try {
    const before = await readFile(join(f.root, "config.json"));
    expect(await f.run({ ...f.command, action: "preview", confirmed: false })).toMatchObject({ state: "preview", credentialRequested: false, written: false, deliveryAuthorized: false });
    expect(f.calls()).toBe(0); expect(await readdir(join(f.root, "state"))).not.toContain("ops-pairing");
    const bound = await f.run(); expect(bound).toMatchObject({ state: "prepared", credential: "stored_private", deliveryAuthorized: false, automaticEnable: false, webhookInvoked: false });
    const n = f.reads(); expect(await f.run()).toEqual(bound); expect(f.calls()).toBe(1); expect(f.reads()).toBe(n);
    const status = await observeOpsTargets({ durableRoot: f.root }); expect(status).toMatchObject({ state: "observed", deliveryAuthorized: false });
    for (const secret of [KEY, PROMPT, "fixture.invalid", f.root]) expect(JSON.stringify(status) + JSON.stringify(bound)).not.toContain(secret);
    const file = join(f.root, "state/ops-pairing/bindings.json"); expect((await stat(file)).mode & 0o077).toBe(0);
    expect(await readFile(file, "utf8")).toContain(KEY); // The intentional secret store, never a public diagnostic view.
    expect(await readdir(join(f.root, "state/ops-pairing"))).toEqual(["bindings.json"]);
    expect(await readFile(join(f.root, "config.json"))).toEqual(before); expect(f.row.isEnabled).toBe(false);
  } finally { await f.close(); }
});

test("lost native acknowledgement consumes the exact binding attempt; another operation cannot bypass it", async () => {
  const f = await pairingFixture(); try {
    f.hook(async () => { throw Error(`lost ${KEY}`); });
    await expect(f.run()).rejects.toMatchObject({ reason: "outcome_unknown" });
    expect(await f.run()).toMatchObject({ state: "outcome_unknown", credential: "not_available" });
    await expect(f.run({ ...f.command, operationId: "new-id" })).rejects.toMatchObject({ reason: "pairing_busy" });
    expect(f.calls()).toBe(1);
    expect(JSON.stringify(await observeOpsTargets({ durableRoot: f.root }))).not.toContain(KEY);
  } finally { await f.close(); }
});

test("config change after key retrieval cannot finalize against a new destination", async () => {
  const f = await pairingFixture(); try {
    f.hook(async () => { await writeFile(join(f.root, "config.json"), JSON.stringify({ ...f.config, ops: { ...f.config.ops, notifications: { mode: "off", maxAutomaticWakeupsPerDay: 1 } } }), { mode: 0o600 }); });
    await expect(f.run()).rejects.toMatchObject({ reason: "outcome_unknown" });
    expect(await f.store.record("default")).toMatchObject({ state: "enrolling", credentialPresent: false });
    expect(await readFile(join(f.root, "state/ops-pairing/bindings.json"), "utf8")).not.toContain(KEY);
  } finally { await f.close(); }
});

test("unbind while native response is pending prevents late response from restoring local credentials", async () => {
  const f = await pairingFixture(); try {
    f.hook(async () => { const record = (await f.store.record("default"))!;
      await revokeOpsTarget({ durableRoot: f.root, alias: "default", expectedRevision: record.revision, action: "unbind", confirmed: true }); });
    await expect(f.run()).rejects.toMatchObject({ reason: "outcome_unknown" });
    expect(await f.store.record("default")).toMatchObject({ state: "unbound", revision: 2, credentialPresent: false });
    expect(await readFile(join(f.root, "state/ops-pairing/bindings.json"), "utf8")).not.toContain(KEY);
  } finally { await f.close(); }
});

test("disable and unbind only mutate local state, retain monotonic revision, and reject stale replay", async () => {
  const f = await pairingFixture(); try {
    await f.run(); const count = f.calls();
    const disabled = await revokeOpsTarget({ durableRoot: f.root, alias: "default", expectedRevision: 1, action: "disable", confirmed: true });
    expect(disabled).toMatchObject({ state: "disabled", revision: 2, remoteCredentialRevoked: false });
    await expect(revokeOpsTarget({ durableRoot: f.root, alias: "default", expectedRevision: 1, action: "unbind", confirmed: true })).rejects.toMatchObject({ reason: "operation_conflict" });
    expect(await revokeOpsTarget({ durableRoot: f.root, alias: "default", expectedRevision: 2, action: "unbind", confirmed: true })).toMatchObject({ state: "unbound", revision: 3 });
    expect(f.calls()).toBe(count); expect(f.row.isEnabled).toBe(false);
    await expect(f.run({ ...f.command, operationId: "bind-two" }, 0)).rejects.toMatchObject({ reason: "operation_conflict" });
    expect(await f.run({ ...f.command, operationId: "bind-two" }, 3)).toMatchObject({ state: "prepared", revision: 4 });
  } finally { await f.close(); }
});

test("unsafe, missing and corrupt existing capsules are never reinitialized into permission to mint", async () => {
  for (const kind of ["missing", "corrupt", "symlink"] as const) {
    const f = await pairingFixture(); try {
      await f.run(); const file = join(f.root, "state/ops-pairing/bindings.json"), calls = f.calls();
      if (kind === "corrupt") await writeFile(file, "{broken", { mode: 0o600 });
      else { await rm(file); if (kind === "symlink") { await writeFile(join(f.root, "victim"), "DO_NOT_TOUCH", { mode: 0o600 }); await symlink(join(f.root, "victim"), file); } }
      expect(await observeOpsTargets({ durableRoot: f.root })).toMatchObject({ state: "unavailable", deliveryAuthorized: false });
      await expect(f.run()).rejects.toMatchObject({ reason: "store_unavailable" }); expect(f.calls()).toBe(calls);
      if (kind === "symlink") expect(await readFile(join(f.root, "victim"), "utf8")).toBe("DO_NOT_TOUCH");
    } finally { await f.close(); }
  }
});

test("invalid/unmanaged/enabled definitions and missing consent cannot request credentials", async () => {
  const f = await pairingFixture(); try {
    await expect(f.run({ ...f.command, confirmed: false })).rejects.toMatchObject({ reason: "confirmation_required" });
    await expect(f.run({ ...f.command, routineId: "not-managed" })).rejects.toMatchObject({ reason: "unmanaged_routine" });
    f.row.isEnabled = true;
    await expect(f.run()).rejects.toBeDefined(); expect(f.calls()).toBe(0);
    expect(await readdir(join(f.root, "state"))).not.toContain("ops-pairing");
  } finally { await f.close(); }
});

test("native credential retrieval is outside config locks and concurrent enrollment grants at most one dispatch", async () => {
  const f = await pairingFixture(); try {
    f.hook(async () => { const lock = await acquireConfigurationLease(f.root); await lock.release(); await new Promise(r => setTimeout(r, 20)); });
    const results = await Promise.allSettled([f.run(), f.run({ ...f.command, operationId: "concurrent" })]);
    expect(results.some(r => r.status === "fulfilled")).toBe(true); expect(f.calls()).toBe(1);
    expect(await f.store.record("default")).toMatchObject({ state: "prepared" });
  } finally { await f.close(); }
});

test("real process death after reserve leaves an unknown guard and readback does not authorize retry", async () => {
  const f = await pairingFixture(); try {
    const worker = fileURLToPath(new URL("./fixtures/pairing-reserve-worker.ts", import.meta.url));
    const child = spawn(process.execPath, [worker, f.root], { env: { PATH: process.env.PATH, HOME: f.root }, stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    let err = ""; child.stderr.on("data", c => err += c);
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => { child.once("close", (_code, signal) => resolve(signal)); child.once("error", reject); });
    expect(signal, err).toBe("SIGKILL");
    expect(await f.run()).toMatchObject({ state: "outcome_unknown" }); expect(f.calls()).toBe(0);
    await expect(f.run({ ...f.command, operationId: "retry" })).rejects.toMatchObject({ reason: "pairing_busy" });
    expect(f.calls()).toBe(0);
  } finally { await f.close(); }
}, 10000);

test("pairing has eight bounded slots, remains separately measured, and never enters diagnostic GC", async () => {
  const f = await pairingFixture(); try {
    await f.run(); const initial = (await f.store.record("default"))!;
    for (let n = 1; n <= 8; n++) {
      const row = { ...f.row, id: `native-${n}` }, catalog = projectNativeRoutines(AGENT, [row]);
      const target = { ...initial.plan.target, alias: `slot-${n}`, routineKey: `slot-${n}` };
      const cmd = { ...f.command, alias: target.alias, routineId: String(row.id), expectedRevision: catalog.routines[0]!.revision, operationId: `slot-${n}` };
      const plan = pairingPlan(cmd, target, initial.plan.scope, { catalog, generation: GENERATION });
      if (n < 8) await f.store.reserve(plan, 0, async () => undefined);
      else await expect(f.store.reserve(plan, 0, async () => undefined)).rejects.toMatchObject({ reason: "capacity" });
    }
    const status = await f.store.status(); expect(status.bindings).toHaveLength(8); expect(status.fileBytes).toBeLessThan(65536);
    const storage = await observeRuntimeStorage({ durableRoot: f.root });
    expect(storage.pairingStorage).toMatchObject({ state: "observed", bindings: 8, automaticGcAllowed: false, credentialValuesIncluded: false });
    expect(JSON.stringify(storage)).not.toContain(KEY);
    expect(await readdir(join(f.root, "state/ops-pairing"))).toEqual(["bindings.json"]);
  } finally { await f.close(); }
});

test("endpoint identity is tied to both Agent and Routine and invalid secret responses never leave public fields", async () => {
  const f = await pairingFixture(); try {
    const valid = await f.run(), record = (await f.store.record("default"))!;
    const plan: PairingPlan = record.plan;
    for (const value of [null, { key: "", url: "https://fixture.invalid" }, { key: KEY, url: "http://fixture.invalid/" },
      { key: KEY, url: `https://fixture.invalid/automations/webhook/${nativeAutomationIdentity("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", f.command.routineId)}` },
      { key: KEY, url: `https://user:pass@fixture.invalid/automations/webhook/${nativeAutomationIdentity(AGENT, f.command.routineId)}` }]) {
      expect(() => validatePairingCredential(value, plan)).toThrow();
    }
    expect(JSON.stringify(valid)).not.toContain(KEY);
  } finally { await f.close(); }
});
