import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { receiverBlueprint, nativeAutomationIdentity, RECEIVER_NOTICE_POLICY_REVISION, RECEIVER_MODEL_SOURCE, type NoticeActivationCommand } from "@grokbox/runtime-kernel/observation";
import { projectNativeRoutines, desiredRoutineDigest } from "@grokbox/runtime-kernel/routines";
import { OWNERSHIP_LOCAL_SOURCE } from "@grokbox/runtime-kernel/contract";
import { openMonitorStore } from "../../src/internal/io/monitor-store.node.ts";
import { openOpsBindings } from "../../src/internal/io/ops-bindings.node.ts";
import { type NotificationRequest } from "../../src/internal/io/native-notification.node.ts";
import { runOpsPairing } from "../../src/internal/roots/ops-pairing.runtime.ts";
import { runRoutineProvisionCommand } from "../../src/internal/roots/routine-provision.runtime.ts";
import { runExplicitOpsNotification, type ExplicitReceiverRead } from "../../src/internal/roots/ops-explicit-delivery.runtime.ts";
import { activateOpsNotifications } from "../../src/internal/roots/ops-activation.runtime.ts";
import { ownedOwnershipSnapshot } from "../ownership-fixture.ts";

export const SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", RECEIVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const MODEL = "f".repeat(64), GENERATION = "c".repeat(64), PROFILE = "d".repeat(64), SOURCE = "e".repeat(64), PRELOAD = "1".repeat(64);
export const tick = (ms = 2) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function automaticFixture(limit = 10) {
  const root = await mkdtemp(join(tmpdir(), "automatic-notice-")), epoch = randomUUID(), configPath = join(root, "config.json");
  const document = validateConfig({ ...defaultConfig(), runtime: { desiredMode: "identity" }, ops: {
    notifications: { maxAutomaticWakeupsPerDay: limit }, targets: { default: { agentId: RECEIVER, routineKey: "ops-notice", maxAutomaticWakeupsPerDay: limit } } } });
  await writeFile(configPath, JSON.stringify(document), { mode: 0o600 });
  const store = openMonitorStore(root); await store.initialize(); await store.begin(epoch, Date.now(), [SUBJECT]);
  const blueprint = receiverBlueprint("ops-notice"); let rows: Record<string, unknown>[] = [], reads = 0;
  const snapshot = () => ({ catalog: projectNativeRoutines(RECEIVER, rows), generation: GENERATION });
  const observe = () => ({ ...snapshot(), definitions: new Map(rows.map(row => [String(row.id), desiredRoutineDigest(blueprint)])) });
  const provision = await runRoutineProvisionCommand({ durableRoot: root,
    command: { action: "apply", agentId: RECEIVER, operationId: "provision", confirmed: true, blueprint },
    native: { list: async () => observe(), write: async () => { rows = [{ ...blueprint, id: "notice-native", createdAt: 1 }]; return observe(); } } });
  await runOpsPairing({ durableRoot: root,
    command: { action: "bind", alias: "default", routineId: "notice-native", expectedRevision: provision.revision!, operationId: "pair", confirmed: true },
    native: { list: async () => snapshot(), credential: async () => ({ generation: GENERATION,
      value: { url: `https://api2.cursor.sh/automations/webhook/${nativeAutomationIdentity(RECEIVER, "notice-native")}`, key: "PRIVATE_TEST_KEY" } }) } });
  const owner = openOpsBindings(root), pairing = (await owner.record("default"))!; rows[0]!.isEnabled = true;
  let nativeChange: ((value: ExplicitReceiverRead) => void) | undefined;
  const readNative = async (): Promise<ExplicitReceiverRead> => {
    reads++;
    const value: ExplicitReceiverRead = { snapshot: snapshot(), promptPolicyRevision: RECEIVER_NOTICE_POLICY_REVISION, consistentGeneration: true,
      ownership: ownedOwnershipSnapshot([RECEIVER]), ownershipGeneration: GENERATION,
      model: { version: 1, source: RECEIVER_MODEL_SOURCE, state: "observed", agentId: RECEIVER, observedAtMs: Date.now(), selection: "native", modelRevision: MODEL,
        loadedProfileRevision: PROFILE, loadedSourceRevision: SOURCE, loadedPreloadRevision: PRELOAD, loadedMode: "identity", reason: "selected",
        scope: "next_local_default_automation_session", executionObserved: false, toolsObserved: false, noModelRequest: true },
      capabilities: { state: "ready", reason: "matched", observed: { version: 1, source: "Host.loaded-runtime-capabilities",
        loaded: { pid: 42, start: 1, profileSha256: PROFILE, sourceSha256: SOURCE, transformedSha256: PRELOAD },
        ownershipLocal: { wrapperVersion: 1, readerVersion: 1, schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE } } } };
    nativeChange?.(value); return value;
  };
  let sequence = 0; const seen = new Set<string>();
  const emit = async () => {
    await tick(); const n = ++sequence, nowMs = Date.now();
    await store.ingestEvidence({ epoch, sourceKey: "2".repeat(64), expectedCursor: n === 1 ? null : String(n - 1), nextCursor: String(n), atMs: nowMs,
      events: [{ name: "host_stream_rejected", schemaVersion: 2, at: new Date(nowMs).toISOString(), mode: "route", hostGenerationId: SOURCE,
        agentId: SUBJECT, stepId: `step-${n}`, turnId: `turn-${n}`, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream", raw: "PRIVATE_INPUT" }] });
    const work = (await store.notificationWork()).find(w => !seen.has(String(w.id)))!; seen.add(String(work.id)); return String(work.id);
  };
  const requests: string[] = []; let response: (res: ServerResponse) => void = res => res.end("PRIVATE_REPLY");
  const server = createServer((req, res) => { let body = ""; req.on("data", bytes => body += bytes); req.on("end", () => { requests.push(body); response(res); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const request: NotificationRequest = (url, options, callback) => httpRequest({ ...options, protocol: "http:", hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, path: url.pathname }, callback);
  const input = { durableRoot: root, readNative };
  const seed = async () => {
    const workId = await emit();
    const result = await runExplicitOpsNotification({ ...input, workId, confirmed: true, expectedBindingRevision: pairing.revision, expectedModelRevision: MODEL }, { request });
    return { workId, result };
  };
  const command = (workId: string): NoticeActivationCommand => ({ alias: "default", fromWorkId: workId, expectedBindingRevision: pairing.revision,
    expectedModelRevision: MODEL, operationId: "activate", confirmed: true, reminderObserved: true });
  return { root, configPath, document, store, owner, pairing, rows, input, readNative, request, requests, reads: () => reads, emit, seed, command,
    mutateNative: (fn: typeof nativeChange) => { nativeChange = fn; }, reply: (fn: typeof response) => { response = fn; },
    activate: (workId: string) => activateOpsNotifications({ ...input, command: command(workId) }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
