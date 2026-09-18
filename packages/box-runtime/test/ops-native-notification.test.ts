import { expect, test } from "bun:test";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { receiverBlueprint, nativeAutomationIdentity, RECEIVER_NOTICE_POLICY_REVISION, RECEIVER_MODEL_SOURCE,
  freezeNotification, type NotificationBinding } from "@grokbox/runtime-kernel/observation";
import { projectNativeRoutines, desiredRoutineDigest } from "@grokbox/runtime-kernel/routines";
import { OWNERSHIP_LOCAL_SOURCE } from "@grokbox/runtime-kernel/contract";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openOpsBindings } from "../src/internal/io/ops-bindings.node.ts";
import { acquireConfigurationLease } from "../src/internal/io/config-lock.node.ts";
import { runOpsPairing } from "../src/internal/roots/ops-pairing.runtime.ts";
import { runRoutineProvisionCommand } from "../src/internal/roots/routine-provision.runtime.ts";
import { runExplicitOpsNotification, type ExplicitReceiverRead } from "../src/internal/roots/ops-explicit-delivery.runtime.ts";
import { NATIVE_NOTIFICATION_HTTP, sendNativeNotification, type NotificationRequest } from "../src/internal/io/native-notification.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", RECEIVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GENERATION = "c".repeat(64), PROFILE = "d".repeat(64), SOURCE = "e".repeat(64), MODEL = "f".repeat(64), PRELOAD = "1".repeat(64);
const KEY = "SYNTHETIC_PRIVATE_WEBHOOK_KEY";
type Reply = (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>;
async function fixture(reply: Reply = (_req, res) => { res.end("PRIVATE_NATIVE_RESPONSE"); }, origin = "https://api2.cursor.sh") {
  const root = await mkdtemp(join(tmpdir(), "native-notice-")), epoch = randomUUID(), configPath = join(root, "config.json");
  const document = validateConfig({ ...defaultConfig(), runtime: { desiredMode: "identity" }, ops: {
    notifications: { maxAutomaticWakeupsPerDay: 10 }, targets: { default: { agentId: RECEIVER, routineKey: "ops-notice", maxAutomaticWakeupsPerDay: 10 } } } });
  await writeFile(configPath, JSON.stringify(document), { mode: 0o600 });
  const store = openMonitorStore(root); await store.initialize(); await store.begin(epoch, Date.now(), [SUBJECT]);
  const blueprint = receiverBlueprint("ops-notice");
  let rows: Record<string, unknown>[] = [], reads = 0;
  const snapshot = () => ({ catalog: projectNativeRoutines(RECEIVER, rows), generation: GENERATION });
  const observe = () => ({ ...snapshot(), definitions: new Map(rows.map(r => [String(r.id), desiredRoutineDigest(blueprint)])) });
  const provision = await runRoutineProvisionCommand({ durableRoot: root,
    command: { action: "apply", agentId: RECEIVER, operationId: "fixture-provision", confirmed: true, blueprint },
    native: { list: async () => observe(), write: async () => { rows = [{ ...blueprint, id: "notice-native", createdAt: 1 }]; return observe(); } } });
  await runOpsPairing({ durableRoot: root,
    command: { action: "bind", alias: "default", routineId: "notice-native", expectedRevision: provision.revision!, operationId: "fixture-pair", confirmed: true },
    native: { list: async () => snapshot(), credential: async () => ({ generation: GENERATION,
      value: { url: `${origin}/automations/webhook/${nativeAutomationIdentity(RECEIVER, "notice-native")}`, key: KEY } }) } });
  const owner = openOpsBindings(root), pairing = (await owner.record("default"))!;
  rows[0]!.isEnabled = true; // Models the separately authorized native enable, NOT an action by the delivery program.
  const readNative = async (): Promise<ExplicitReceiverRead> => {
    reads++;
    return { snapshot: snapshot(), promptPolicyRevision: RECEIVER_NOTICE_POLICY_REVISION, consistentGeneration: true,
      ownership: ownedOwnershipSnapshot([RECEIVER]), ownershipGeneration: GENERATION,
      model: { version: 1, source: RECEIVER_MODEL_SOURCE, state: "observed", agentId: RECEIVER, observedAtMs: Date.now(),
        selection: "native", modelRevision: MODEL, loadedProfileRevision: PROFILE, loadedSourceRevision: SOURCE,
        loadedPreloadRevision: PRELOAD, loadedMode: "identity", reason: "selected", scope: "next_local_default_automation_session",
        executionObserved: false, toolsObserved: false, noModelRequest: true },
      capabilities: { state: "ready", reason: "matched", observed: { version: 1, source: "Host.loaded-runtime-capabilities",
        loaded: { pid: 42, start: 1, profileSha256: PROFILE, sourceSha256: SOURCE, transformedSha256: PRELOAD },
        ownershipLocal: { wrapperVersion: 1, readerVersion: 1, schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE } } } };
  };
  let sequence = 0;
  const emit = async () => {
    const n = ++sequence, now = Date.now();
    await store.ingestEvidence({ epoch, sourceKey: "2".repeat(64), expectedCursor: n === 1 ? null : String(n - 1), nextCursor: String(n), atMs: now,
      events: [{ name: "host_stream_rejected", schemaVersion: 2, at: new Date(now).toISOString(), mode: "route", hostGenerationId: SOURCE,
        agentId: SUBJECT, stepId: `step-${n}`, turnId: `turn-${n}`, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream", raw: "PRIVATE_TASK_BODY" }] });
    const work = (await store.notificationWork()).find(w => !seen.has(String(w.id)))!; seen.add(String(work.id)); return String(work.id);
  };
  const seen = new Set<string>(), requests: Array<{ url: string; body: string; headers: IncomingMessage["headers"] }> = [];
  const server = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", text => { body += text; });
    req.once("end", () => {
      requests.push({ url: req.url!, body, headers: req.headers });
      Promise.resolve(reply(req, res, body)).catch(() => res.destroy());
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let transports = 0; const events: string[] = [];
  const request: NotificationRequest = (url, options, callback) => {
    transports++;
    expect(url.origin).toBe(NATIVE_NOTIFICATION_HTTP.origin);
    expect(options.rejectUnauthorized).toBe(true); expect(options.agent).toBe(false); expect(options.method).toBe("POST");
    // Only this owned test boundary maps the already-validated native URL to a
    // loopback HTTP fixture. Production exposes no URL, proxy or transport flag.
    const req = httpRequest({ ...options, protocol: "http:", hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, path: url.pathname }, response => {
      events.push(`response:${response.statusCode}`);
      response.once("end", () => events.push(`end:${response.complete}`)); response.once("aborted", () => events.push("aborted"));
      response.once("error", () => events.push("response-error")); response.once("close", () => events.push("response-close"));
      callback(response);
    });
    req.once("close", () => events.push("request-close")); req.once("error", () => events.push("request-error"));
    return req;
  };
  const input = (workId: string) => ({ durableRoot: root, workId, expectedBindingRevision: pairing.revision, expectedModelRevision: MODEL, confirmed: true, readNative });
  return { root, configPath, document, store, owner, pairing, rows, httpPort: (server.address() as AddressInfo).port, readNative, reads: () => reads, emit, request, input, requests, events, transports: () => transports,
    send: (workId: string) => runExplicitOpsNotification(input(workId), { request }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); } };
}

test("explicit delivery crosses a real HTTP boundary after durable reservation, without exporting credentials or enabling automation", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async (_req, res, body) => {
    const workId = JSON.parse(body).workId;
    expect(await f.store.notificationDelivery(workId)).toMatchObject({ state: "unknown", attempt: { state: "attempting" } });
    const lock = await acquireConfigurationLease(f.root); await lock.release(); await f.store.maintain(Date.now());
    res.end("PRIVATE_NATIVE_RESPONSE");
  });
  try {
    const workId = await f.emit(), capsule = await readFile(join(f.root, "state/ops-pairing/bindings.json"));
    const result = await f.send(workId);
    expect(result, JSON.stringify(f.events)).toMatchObject({ state: "native-accepted", automaticDeliveryEnabled: false, credentialsRequested: false, routineChanged: false,
      actualReceiverTurn: "not_observed", botReport: "not_observed", userRead: "not_observed" });
    expect(f.requests).toHaveLength(1); expect(f.transports()).toBe(1);
    expect(f.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(f.requests[0]!.url).toBe(`/automations/webhook/${nativeAutomationIdentity(RECEIVER, "notice-native")}`);
    expect(Buffer.byteLength(f.requests[0]!.body)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(f.requests[0]!.body).notice).toMatchObject({ behavior: "notify_then_end", automaticDiagnosis: false, automaticIssue: false });
    for (const secret of [KEY, "PRIVATE_TASK_BODY", "PRIVATE_NATIVE_RESPONSE", f.root]) {
      expect(JSON.stringify(result)).not.toContain(secret); expect(f.requests[0]!.body).not.toContain(secret);
      expect(JSON.stringify(await f.store.notificationDelivery(workId))).not.toContain(secret);
    }
    expect(await readFile(join(f.root, "state/ops-pairing/bindings.json"))).toEqual(capsule);
    const beforeReads = f.reads(); expect(await f.send(workId)).toMatchObject({ state: "already_attempted" });
    expect(f.reads()).toBe(beforeReads); expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

for (const status of [401, 429, 201, 204, 302, 500]) test(`HTTP ${status} is not disguised as successful delivery and is never retried`, async () => {
  const f = await fixture((_req, res) => { res.writeHead(status, { location: "https://untrusted.invalid/steal-key" }); res.end("PRIVATE_ERROR"); });
  try {
    const workId = await f.emit(), result = await f.send(workId);
    expect(result.state).toBe([401, 429].includes(status) ? "definitely-not-accepted" : "unknown");
    expect(await f.send(workId)).toMatchObject({ state: "already_attempted" });
    expect(f.requests).toHaveLength(1); expect(f.transports()).toBe(1); expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR");
  } finally { await f.close(); }
});

for (const scenario of ["disabled", "model", "definition", "temporal", "scope", "profile", "stale", "generation"]) test(`${scenario} mismatch refuses before the HTTP boundary`, async () => {
  const f = await fixture();
  try {
    const workId = await f.emit();
    const result = await runExplicitOpsNotification({ ...f.input(workId), readNative: async () => {
      const native = await f.readNative();
      if (scenario === "disabled") native.snapshot.catalog.routines[0]!.enabled = false;
      if (scenario === "definition") native.snapshot.catalog.routines[0]!.definitionRevision = "9".repeat(64);
      if (scenario === "model") native.model!.modelRevision = "9".repeat(64);
      if (scenario === "temporal") native.ownership = ownedOwnershipSnapshot([RECEIVER], { serverHarness: "temporal" });
      if (scenario === "scope") (native.ownership as { scope: { stable: boolean } }).scope.stable = false;
      if (scenario === "profile") native.capabilities.observed!.loaded.profileSha256 = "9".repeat(64);
      if (scenario === "stale") native.model!.observedAtMs -= 6000;
      if (scenario === "generation") native.ownershipGeneration = "9".repeat(64);
      return native;
    } }, { request: f.request });
    expect(result.state).toBe("unavailable"); expect(f.transports()).toBe(0);
    expect(await f.store.notificationDelivery(workId)).toMatchObject({ attempt: null });
  } finally { await f.close(); }
});

test("unsupported endpoint origin cannot receive a private key even when it came from a prepared capsule", async () => {
  const f = await fixture(undefined, "https://untrusted.invalid");
  try {
    const workId = await f.emit(); expect((await f.send(workId)).state).toBe("definitely-not-accepted");
    expect(f.transports()).toBe(0); expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});

test("connection loss and oversize success bodies remain uncertain without replay or a secret-bearing error", async () => {
  for (const mode of ["disconnect", "oversize"] as const) {
    const f = await fixture((req, res) => { if (mode === "disconnect") req.socket.destroy(); else res.end("PRIVATE_ERROR".repeat(5000)); });
    try {
      const workId = await f.emit(); expect((await f.send(workId)).state).toBe("unknown");
      expect(await f.send(workId)).toMatchObject({ state: "already_attempted" }); expect(f.requests).toHaveLength(1);
      expect(JSON.stringify(await f.store.notificationDelivery(workId))).not.toContain("PRIVATE_ERROR");
    } finally { await f.close(); }
  }
});

test("concurrent explicit calls share the original work reservation and spend only one POST", async () => {
  const f = await fixture();
  try {
    const workId = await f.emit(); await Promise.all([f.send(workId), f.send(workId)]);
    expect(f.requests).toHaveLength(1); expect(f.transports()).toBe(1);
  } finally { await f.close(); }
});

test("cancellation after request receipt closes transport, records uncertainty and cannot become permission to resend", async () => {
  const controller = new AbortController();
  const f = await fixture(() => { controller.abort(); });
  try {
    const workId = await f.emit();
    await runExplicitOpsNotification({ ...f.input(workId), signal: controller.signal }, { request: f.request }).catch(() => undefined);
    expect(await f.store.notificationDelivery(workId)).toMatchObject({ state: "unknown" });
    expect(await f.send(workId)).toMatchObject({ state: "already_attempted" }); expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

test("fresh revalidation detects a model change after reservation and never starts HTTP", async () => {
  const f = await fixture(); let reads = 0;
  try {
    const workId = await f.emit();
    const result = await runExplicitOpsNotification({ ...f.input(workId), readNative: async () => {
      const v = await f.readNative(); if (++reads > 1) v.model!.modelRevision = "9".repeat(64); return v;
    } }, { request: f.request });
    expect(result.state).toBe("definitely-not-accepted"); expect(f.transports()).toBe(0);
    expect(await f.send(workId)).toMatchObject({ state: "already_attempted" });
  } finally { await f.close(); }
});

test("actual Node transport waits for a complete response and closes before returning its finite receipt", async () => {
  const f = await fixture();
  try {
    const entry = join(f.root, "transport.mjs"), inputPath = join(f.root, "synthetic-input.json");
    await build({ entryPoints: [fileURLToPath(new URL("./fixtures/native-notification-http-worker.ts", import.meta.url))],
      outfile: entry, bundle: true, platform: "node", target: "node20", format: "esm", logLevel: "silent" });
    const workId = await f.emit(), now = Date.now();
    const binding: NotificationBinding = { bindingId: f.pairing.bindingId, revision: f.pairing.revision,
      ...f.pairing.plan.scope, targetAlias: "default", agentId: RECEIVER, routineKey: "ops-notice", routineId: "notice-native",
      routineRevision: f.pairing.plan.routineRevision, modelRevision: MODEL, qualificationRevision: SOURCE,
      policyRevision: f.pairing.plan.target.policyRevision, dataPolicy: "safe-summary", receiverMode: "notify_then_end", observedAtMs: now, validUntilMs: now + 5000 };
    const notice = freezeNotification({ scope: f.pairing.plan.scope, target: f.pairing.plan.target, binding, workId, attemptId: randomUUID(),
      createdAtMs: now, expiresAtMs: now + 10000, notice: await f.store.notificationNotice(workId) });
    await writeFile(inputPath, JSON.stringify({ plan: f.pairing.plan, binding, body: notice.serialized, envelopeDigest: notice.frozen.envelopeDigest,
      credential: { url: `https://api2.cursor.sh/automations/webhook/${nativeAutomationIdentity(RECEIVER, "notice-native")}`, key: KEY } }), { mode: 0o600 });
    const child = spawn("node", [entry, inputPath, String(f.httpPort)], { cwd: f.root,
      env: { PATH: process.env.PATH, HOME: f.root }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let out = "", err = ""; child.stdout.on("data", c => out += c); child.stderr.on("data", c => err += c);
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(exit, err).toBe(0); expect(JSON.parse(out)).toEqual({ state: "native-accepted" }); expect(err).toBe("");
    expect(out).not.toContain(KEY); expect(f.requests).toHaveLength(1); expect(f.requests[0]!.body).toBe(notice.serialized);
  } finally { await f.close(); }
}, 15000);

test("confirmation and reviewed model fingerprints are required before any local or native work", async () => {
  const f = await fixture();
  try {
    const workId = await f.emit(), before = await readFile(f.store.path);
    await expect(runExplicitOpsNotification({ ...f.input(workId), confirmed: false }, { request: f.request })).rejects.toBeDefined();
    await expect(runExplicitOpsNotification({ ...f.input(workId), expectedModelRevision: "invented" }, { request: f.request })).rejects.toBeDefined();
    expect(f.reads()).toBe(0); expect(f.transports()).toBe(0); expect(await readFile(f.store.path)).toEqual(before);
  } finally { await f.close(); }
});

test("body substitution is rejected at the private HTTP boundary even with a matching caller-provided digest", async () => {
  const f = await fixture();
  try {
    const workId = await f.emit();
    const now = Date.now(), binding: NotificationBinding = { bindingId: f.pairing.bindingId, revision: f.pairing.revision,
      ...f.pairing.plan.scope, targetAlias: "default", agentId: RECEIVER, routineKey: "ops-notice", routineId: "notice-native",
      routineRevision: f.pairing.plan.routineRevision, modelRevision: MODEL, qualificationRevision: SOURCE,
      policyRevision: f.pairing.plan.target.policyRevision, dataPolicy: "safe-summary", receiverMode: "notify_then_end", observedAtMs: now, validUntilMs: now + 5000 };
    const notification = freezeNotification({ scope: f.pairing.plan.scope, target: f.pairing.plan.target, binding, workId,
      attemptId: randomUUID(), createdAtMs: now, expiresAtMs: now + 10000, notice: await f.store.notificationNotice(workId) });
    const value = JSON.parse(notification.serialized); value.notice.summary = "PRIVATE_INJECTED_PAYLOAD";
    const body = canonicalJson(value);
    expect(await sendNativeNotification({ plan: f.pairing.plan, credential: { url: `https://api2.cursor.sh/automations/webhook/${nativeAutomationIdentity(RECEIVER, "notice-native")}`, key: KEY },
      binding, body, envelopeDigest: sha256Text(body), signal: new AbortController().signal }, f.request))
      .toMatchObject({ state: "definitely-not-accepted" });
    expect(f.transports()).toBe(0);
  } finally { await f.close(); }
});
