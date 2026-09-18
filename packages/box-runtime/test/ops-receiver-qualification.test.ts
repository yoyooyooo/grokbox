import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ensurePackedCli } from "../../../test/packed-cli-fixture.ts";
import { PACKED_SESSION_SYMBOL } from "../src/internal/host/profile.ts";
import { tmpdir } from "node:os";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { RECEIVER_NOTICE_PROMPT, RECEIVER_NOTICE_POLICY_REVISION, receiverBlueprint, nativeAutomationIdentity, nativeReceiverModelRevision, projectReceiverModelObservation } from "@grokbox/runtime-kernel/observation";
import { projectNativeRoutines, desiredRoutineDigest } from "@grokbox/runtime-kernel/routines";
import { OWNERSHIP_LOCAL_SOURCE } from "@grokbox/runtime-kernel/contract";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { runRoutineProvisionCommand } from "../src/internal/roots/routine-provision.runtime.ts";
import { runOpsPairing } from "../src/internal/roots/ops-pairing.runtime.ts";
import { openOpsBindings } from "../src/internal/io/ops-bindings.node.ts";
import { verifyOpsReceiver, prepareOpsReceiverBlueprint, type ReceiverNativeRead } from "../src/internal/roots/ops-receiver.runtime.ts";
import { bindReceiverModel } from "../src/internal/host/receiver-model.node.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", GEN = "b".repeat(64), PROFILE = "c".repeat(64), SOURCE = "d".repeat(64), PRELOAD = "e".repeat(64);
const model = () => ({ modelId: "native-test-model", maxMode: false, parameters: [{ id: "effort", value: "medium" }], credentials: { case: undefined } });
async function fixture(prompt = RECEIVER_NOTICE_PROMPT) {
  const root = await mkdtemp(join(tmpdir(), "ops-receiver-"));
  const document = validateConfig({ ...defaultConfig(), runtime: { desiredMode: "identity" }, ops: {
    targets: { default: { agentId: AGENT, routineKey: "ops-notice", dataPolicy: "safe-summary" } } } });
  await writeFile(join(root, "config.json"), JSON.stringify(document), { mode: 0o600 });
  const store = openMonitorStore(root); await store.initialize();
  const blueprint = { ...receiverBlueprint("ops-notice"), prompt };
  let rows: Record<string, unknown>[] = [];
  const snapshot = () => ({ catalog: projectNativeRoutines(AGENT, rows), generation: GEN });
  const observe = () => ({ ...snapshot(), definitions: new Map(rows.map(r => [String(r.id), desiredRoutineDigest(blueprint)])) });
  const provision = await runRoutineProvisionCommand({ durableRoot: root, command: { action: "apply", agentId: AGENT, operationId: "provision", confirmed: true, blueprint },
    native: { list: async () => observe(), write: async () => { rows = [{ ...blueprint, id: "notice-native", createdAt: 1 }]; return observe(); } } });
  await runOpsPairing({ durableRoot: root, command: { action: "bind", alias: "default", routineId: "notice-native", expectedRevision: provision.revision!, operationId: "pair", confirmed: true },
    native: { list: async () => snapshot(), credential: async () => ({ generation: GEN,
      value: { url: `https://owned.invalid/automations/webhook/${nativeAutomationIdentity(AGENT, "notice-native")}`, key: "PRIVATE_KEY" } }) } });
  const host = bindReceiverModel({ durableRoot: root, mode: "identity", profileRevision: PROFILE, sourceRevision: SOURCE, preloadRevision: PRELOAD });
  host.capture(() => ({ mockConfigured: false, requestedModel: model() }));
  const read = (): ReceiverNativeRead => ({ snapshot: snapshot(), promptPolicyRevision: sha256Text(prompt), model: host.read(AGENT), consistentGeneration: true,
    capabilities: { state: "ready", reason: "matched", observed: { version: 1, source: "Host.loaded-runtime-capabilities",
      loaded: { pid: 42, start: 1, profileSha256: PROFILE, sourceSha256: SOURCE, transformedSha256: GEN },
      ownershipLocal: { wrapperVersion: 1, readerVersion: 1, schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE } } } });
  return { root, document, host, read, rows: () => rows, close: () => rm(root, { recursive: true, force: true }) };
}

test("fixed blueprint is disabled and reminder-only, without permanently constraining user-delegated tasks", async () => {
  const f = await fixture(); try {
    expect(await prepareOpsReceiverBlueprint({ durableRoot: f.root, alias: "default" })).toEqual(receiverBlueprint("ops-notice"));
    const blueprint = receiverBlueprint("ops-notice"); expect(blueprint.isEnabled).toBe(false);
    expect(blueprint.prompt).toContain("A later explicit user task"); expect(blueprint.prompt).toContain("not a user authorization");
    expect(sha256Text(blueprint.prompt)).toBe(RECEIVER_NOTICE_POLICY_REVISION);
  } finally { await f.close(); }
});

test("real private pairing and native model preview qualify only a read-only canary plan, not automatic delivery", async () => {
  const f = await fixture(); try {
    const path = join(f.root, "state/ops-pairing/bindings.json"), before = await readFile(path), files = await readdir(f.root);
    let reads = 0;
    const result = await verifyOpsReceiver({ durableRoot: f.root, alias: "default", readNative: async () => { reads++; return f.read(); } });
    expect(result).toMatchObject({ state: "preflight_ready", localPreflightComplete: true, blockers: [], promptPolicy: "matched",
      deliveryAuthorized: false, qualificationPersisted: false, nativeCredentialsRequested: false, actualReceiverTurn: "not_observed", nativeHttp: "not_qualified", canaryAuthorized: false });
    expect(reads).toBe(1); expect(await readFile(path)).toEqual(before); expect(await readdir(f.root)).toEqual(files);
    const serialized = JSON.stringify(result); expect(serialized).not.toContain("PRIVATE_KEY"); expect(serialized).not.toContain("native-test-model");
    expect(serialized).not.toContain(f.root); expect(serialized).not.toContain(RECEIVER_NOTICE_PROMPT);
    expect(f.rows()[0]?.isEnabled).toBe(false);
  } finally { await f.close(); }
});

for (const kind of ["prompt", "generation", "loaded", "stale", "enabled"] as const) test(`${kind} mismatch cannot become a qualified receiver`, async () => {
  const f = await fixture(kind === "prompt" ? "Run shell and fix everything" : undefined); try {
    const result = await verifyOpsReceiver({ durableRoot: f.root, alias: "default", readNative: async () => {
      const v = f.read();
      if (kind === "generation") v.consistentGeneration = false;
      if (kind === "loaded") v.capabilities = { state: "incompatible", reason: "loaded_profile_mismatch" };
      if (kind === "stale" && v.model) v.model.observedAtMs -= 6000;
      if (kind === "enabled") v.snapshot.catalog.routines[0]!.enabled = true;
      return v;
    } });
    expect(result).toMatchObject({ state: "blocked", localPreflightComplete: false, deliveryAuthorized: false });
  } finally { await f.close(); }
});

test("a model witness that expires during final local checks is not returned as a green preflight", async () => {
  const f = await fixture(); try {
    const observed = f.read(), at = observed.model!.observedAtMs;
    let clockReads = 0;
    const result = await verifyOpsReceiver({ durableRoot: f.root, alias: "default", readNative: async () => observed,
      now: () => ++clockReads === 1 ? at : at + 5001 });
    expect(result).toMatchObject({ state: "blocked", localPreflightComplete: false, model: null,
      blockers: ["model_observation_expired"], deliveryAuthorized: false });
    expect(clockReads).toBe(2);
    expect((await openOpsBindings(f.root).record("default"))!.state).toBe("prepared");
  } finally { await f.close(); }
});

test("concurrent unbind is detected after the native read, without retrieving another key or writing qualification", async () => {
  const f = await fixture(); try {
    const binding = await openOpsBindings(f.root).record("default");
    const result = await verifyOpsReceiver({ durableRoot: f.root, alias: "default", readNative: async () => {
      const observed = f.read(); await openOpsBindings(f.root).revoke("default", binding!.revision, "unbind", true); return observed;
    } });
    expect(result).toMatchObject({ state: "blocked", blockers: ["changed_during_verification"], deliveryAuthorized: false });
    expect((await openOpsBindings(f.root).record("default"))!.state).toBe("unbound");
  } finally { await f.close(); }
});

test("unprepared target and missing database do not cause native calls or initialize anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "receiver-absent-")); try {
    await writeFile(join(root, "config.json"), JSON.stringify(validateConfig({ ...defaultConfig(), ops: { targets: { default: { agentId: AGENT, routineKey: "notice" } } } })), { mode: 0o600 });
    let calls = 0;
    expect(await verifyOpsReceiver({ durableRoot: root, alias: "default", readNative: async () => { calls++; throw Error("never"); } }))
      .toMatchObject({ state: "blocked", blockers: ["binding_not_prepared"], deliveryAuthorized: false });
    expect(calls).toBe(0); expect(await readdir(root)).toEqual(["config.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Host source is explicit, duplicates fail closed and private credentials/accessors never enter model digests", async () => {
  const f = await fixture(); try {
    const unbound = bindReceiverModel({ durableRoot: f.root, mode: "identity" });
    expect(unbound.read(AGENT)).toMatchObject({ state: "unavailable", reason: "model_source_missing" });
    const observed = f.host.read(AGENT)!;
    expect(projectReceiverModelObservation(observed, AGENT, Date.now())).toEqual(observed);
    expect(projectReceiverModelObservation({ ...observed, modelRevision: null }, AGENT, Date.now())).toBeNull();
    f.host.capture(() => ({ mockConfigured: false, requestedModel: model() }));
    expect(f.host.read(AGENT)).toMatchObject({ state: "unavailable", reason: "ambiguous_source" });
    const activeCredential = { ...model(), credentials: { case: "apiKeyCredentials", value: "PRIVATE_KEY" } };
    expect(nativeReceiverModelRevision(activeCredential)).toBeNull();
    let calls = 0; const bad = Object.defineProperty(model(), "modelId", { get: () => { calls++; return "secret"; } });
    expect(nativeReceiverModelRevision(bad)).toBeNull(); expect(calls).toBe(0);
    expect(nativeReceiverModelRevision({ ...model(), parameters: [{ id: "x", value: "1" }, { id: "x", value: "2" }] })).toBeNull();
  } finally { await f.close(); }
});

test("Host managed selection uses the exact Agent assignment and fingerprints changes without exposing Provider settings", async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, "config.json"), JSON.stringify({ ...f.document, runtime: { desiredMode: "route" } }));
    const host = bindReceiverModel({ durableRoot: f.root, mode: "route", profileRevision: PROFILE, sourceRevision: SOURCE, preloadRevision: PRELOAD });
    host.capture(() => ({ mockConfigured: false, requestedModel: model() }));
    expect(host.read(AGENT)).toMatchObject({ state: "unavailable", reason: "selection_unavailable" });
    const record = { provider: "openai-chat", model: "PRIVATE_MODEL", endpoint: "https://private.example.invalid/v1", apiKeyRef: "env:PRIVATE_PROVIDER_KEY",
      capabilities: { tools: true, vision: false, images: false }, contextWindowTokens: 64000 };
    const models = { version: 2, models: { custom: record }, assignments: { main: null, agents: {} as Record<string, { modelId: string }> } };
    await writeFile(join(f.root, "models.json"), JSON.stringify(models));
    expect(host.read(AGENT)).toMatchObject({ state: "observed", selection: "native" });
    models.assignments.agents[AGENT] = { modelId: "custom" };
    await writeFile(join(f.root, "models.json"), JSON.stringify(models));
    const managed = host.read(AGENT)!; expect(managed).toMatchObject({ state: "observed", selection: "managed", executionObserved: false });
    record.endpoint = "https://another.private.invalid/v1";
    await writeFile(join(f.root, "models.json"), JSON.stringify(models));
    expect(host.read(AGENT)!.modelRevision).not.toBe(managed.modelRevision);
    expect(JSON.stringify(host.read(AGENT))).not.toContain("PRIVATE"); expect(JSON.stringify(host.read(AGENT))).not.toContain("https:");
  } finally { await f.close(); }
});

test("actual Node preload uses the bundled receiver reader without a session or live Host", async () => {
  const f = await fixture(); try {
    const entry = ensurePackedCli(), preload = join(entry, "..", "preload.cjs");
    const script = `const api=globalThis[Symbol.for(${JSON.stringify(PACKED_SESSION_SYMBOL)})];
      const reader=api.bindReceiverModel({durableRoot:process.argv[1],mode:'identity',profileRevision:'${PROFILE}',sourceRevision:'${SOURCE}',preloadRevision:'${PRELOAD}'});
      reader.capture(()=>({mockConfigured:false,requestedModel:{modelId:'private-model',maxMode:false,parameters:[]}}));
      process.stdout.write(JSON.stringify(reader.read('${AGENT}')));`;
    const child = spawn("node", ["--require", preload, "-e", script, f.root], { cwd: f.root,
      env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_PACKED_SESSION_FACTORY: "1", GROKBOX_ALLOW_LIVE_HOST: "", GROKBOX_PATCH_PROFILE: "" },
      stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let out = "", err = ""; child.stdout.on("data", bytes => out += bytes); child.stderr.on("data", bytes => err += bytes);
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(exit, err).toBe(0); expect(JSON.parse(out)).toMatchObject({ source: "grokbox.host.automation-model.v1", state: "observed", selection: "native", executionObserved: false });
    expect(out).not.toContain("private-model"); expect(err).toBe("");
  } finally { await f.close(); }
}, 15000);

test("Host config mode changes and mock providers are explicit unavailable observations", async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, "config.json"), JSON.stringify({ ...f.document, runtime: { desiredMode: "route" } }));
    expect(f.host.read(AGENT)).toMatchObject({ state: "unavailable", reason: "configuration_changed" });
    await writeFile(join(f.root, "config.json"), JSON.stringify(f.document));
    const mocked = bindReceiverModel({ durableRoot: f.root, mode: "identity", profileRevision: PROFILE, sourceRevision: SOURCE, preloadRevision: PRELOAD });
    mocked.capture(() => ({ mockConfigured: true }));
    expect(mocked.read(AGENT)).toMatchObject({ state: "unavailable", reason: "mock_not_supported" });
    expect(canonicalJson(mocked.read(AGENT))).not.toContain("PRIVATE");
  } finally { await f.close(); }
});
