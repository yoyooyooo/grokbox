import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, notificationIdentity, normalizeReceiverChange, type ReceiverChangeRequest, type ReceiverOperation, type NotificationView } from "../src/client.ts";
const I = "11111111-1111-4111-8111-111111111111", D = "22222222-2222-4222-8222-222222222222", B = "33333333-3333-4333-8333-333333333333";
const ref = `receiver:${I}:${D}:${B}`, hash = "a".repeat(64);
const request = (): ReceiverChangeRequest => ({ receiverRef: ref, requestId: randomUUID(), expectedRevision: 1, action: "enable", expectedModelRevision: hash, confirmed: true });
const envelope = (data: unknown) => Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: true, data });
function client(data: () => unknown) {
  let calls = 0;
  const api = new ManagementClient({ baseUrl: "http://127.0.0.1:3333", installationId: I,
    fetch: Object.assign(async () => { calls++; return envelope(data()); }, { preconnect: () => undefined }) as typeof fetch });
  return { api, calls: () => calls };
}
const operation = (input: ReceiverChangeRequest): ReceiverOperation => ({ version: 1, operationRef: `receiver-operation:${I}:${D}:${hash}`, receiverRef: ref,
  requestId: input.requestId, action: "enable", beforeRevision: 1, appliedRevision: 2, appliedAtMs: Date.now(), authorizationId: B,
  state: "succeeded", notificationSent: false, testRequired: false });

test("receiver normalization rejects legacy seed flags, missing consent and foreign/unbound references before transport", async () => {
  const f = client(() => null), input = request();
  for (const patch of [{ fromWorkId: B }, { reminderObserved: true }, { confirmed: false }, { expectedRevision: 1.5 }, { expectedModelRevision: "bad" }, { requestId: "bad" }]) {
    await expect(f.api.changeReceiver({ ...input, ...patch } as never)).rejects.toMatchObject({ code: "invalid_input" });
  }
  await expect(f.api.changeReceiver({ ...input, receiverRef: ref.replace(I, B) })).rejects.toMatchObject({ code: "wrong_installation" });
  expect(() => notificationIdentity(ref, undefined as never)).toThrow();
  const unbound = new ManagementClient({ baseUrl: "http://127.0.0.1:3333", fetch: (() => { throw Error("not-submitted"); }) as never });
  await expect(unbound.receiver(ref)).rejects.toMatchObject({ code: "wrong_installation" });
  expect(f.calls()).toBe(0);
  const normalized = normalizeReceiverChange(input, I); input.expectedRevision = 99; expect(normalized.expectedRevision).toBe(1);
});

test("receiver mutation success must bind action, original target, request, revisions and no-send semantics", async () => {
  const input = request(), valid = operation(input);
  for (const patch of [{ requestId: randomUUID() }, { receiverRef: ref.replace(B, randomUUID()) }, { action: "disable", authorizationId: null },
    { appliedRevision: 5 }, { beforeRevision: 0 }, { notificationSent: true }, { testRequired: true }, { operationRef: valid.operationRef + ":extra" }, { credential: "private" }]) {
    const f = client(() => ({ ...valid, ...patch }));
    await expect(f.api.changeReceiver(input)).rejects.toMatchObject({ code: "operation_unknown", details: { requestId: input.requestId, lookupPath: `/v1/notification-receiver-operations/${D}/${input.requestId}` } });
    expect(f.calls()).toBe(1);
  }
  expect((await client(() => valid).api.changeReceiver(input)).data).toEqual(valid);
});

test("delayed credential resolution cannot change a receiver request or its recovery domain", async () => {
  const input = request(); let release!: (value: string) => void; let body: unknown;
  const api = new ManagementClient({ baseUrl: "http://127.0.0.1:3333", installationId: I,
    credential: () => new Promise(resolve => { release = resolve; }), fetch: Object.assign(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(init!.body as string); throw Error("response-lost");
    }, { preconnect: () => undefined }) as typeof fetch });
  const original = structuredClone(input), pending = api.changeReceiver(input); await Promise.resolve();
  input.requestId = randomUUID(); input.receiverRef = `receiver:${I}:${D}:${I}`; input.expectedRevision = 100;
  release("synthetic-token");
  await expect(pending).rejects.toMatchObject({ code: "operation_unknown", details: { requestId: original.requestId } });
  expect(body).toEqual(original);
});

test("retry views bind bounded history to the exact latest attempt and reject unknown-to-retry promotion", async () => {
  const value: NotificationView = { notificationRef: `notification:${I}:${D}:${B}`, databaseId: D, workId: B, purpose: "incident",
    incidentRef: `incident:${I}:${D}:${B}`, evidenceRevision: 1, state: "blocked", createdAtMs: 1, expiresAtMs: 100000,
    attempt: { attemptId: B, state: "definitely-not-accepted", targetAgentId: B, bindingRevision: 1, envelopeDigest: hash,
      envelopeBytes: 100, reservedAtMs: 2, settledAtMs: 3 }, automaticRetry: false, botReport: "not_observed", userRead: "not_observed",
    retry: { state: "ready", reason: "definite_rejection", attempts: 1, notBeforeMs: 30003 },
    attemptHistory: [{ attemptId: B, state: "definitely-not-accepted", reservedAtMs: 2, settledAtMs: 3 }] };
  expect((await client(() => value).api.notification(value.notificationRef)).data).toEqual(value);
  const quarantined: NotificationView = { ...value, state: "unknown", retry: { state: "not_retryable", reason: "work_outcome_unknown", attempts: 1, notBeforeMs: null } };
  expect((await client(() => quarantined).api.notification(value.notificationRef)).data).toEqual(quarantined);
  await expect(client(() => ({ ...quarantined, state: "blocked" })).api.notification(value.notificationRef)).rejects.toMatchObject({ code: "protocol_error" });
  for (const patch of [
    { state: "unknown" },
    { retry: { ...value.retry, attempts: 4 } }, { retry: { ...value.retry, notBeforeMs: 100001 } },
    { attemptHistory: [{ ...value.attemptHistory![0], state: "unknown" }] },
    { attemptHistory: [{ ...value.attemptHistory![0], body: "private" }] },
    { attemptHistory: [{ ...value.attemptHistory![0], attemptId: I }] },
    { purpose: "test", incidentRef: null, evidenceRevision: null },
  ]) await expect(client(() => ({ ...value, ...patch })).api.notification(value.notificationRef)).rejects.toMatchObject({ code: "protocol_error" });
});

test("test delivery DTOs reject fake incidents, false receipt claims, payload leakage and malformed cursor continuation", async () => {
  const value: NotificationView = { notificationRef: `notification:${I}:${D}:${B}`, databaseId: D, workId: B, purpose: "test", incidentRef: null,
    evidenceRevision: null, state: "unknown", createdAtMs: 1, expiresAtMs: 10, attempt: { attemptId: B, state: "unknown", targetAgentId: B,
      bindingRevision: 1, envelopeDigest: hash, envelopeBytes: 100, reservedAtMs: 2, settledAtMs: 3 }, automaticRetry: false, botReport: "not_observed", userRead: "not_observed" };
  expect((await client(() => value).api.notification(value.notificationRef)).data).toEqual(value);
  for (const patch of [{ incidentRef: `incident:${I}:${D}:${B}`, evidenceRevision: 1 }, { state: "completed" }, { userRead: "read" }, { automaticRetry: true }, { body: "private" }, { expiresAtMs: 0 }]) {
    await expect(client(() => ({ ...value, ...patch })).api.notification(value.notificationRef)).rejects.toMatchObject({ code: "protocol_error" });
  }
  await expect(client(() => ({ notifications: [value, value], databaseId: D, nextCursor: null, coverage: "retained-work" })).api.notifications()).rejects.toMatchObject({ code: "protocol_error" });
  await expect(client(() => ({ notifications: [value], databaseId: D, nextCursor: `${D}:bad`, coverage: "retained-work" })).api.notifications()).rejects.toMatchObject({ code: "protocol_error" });
});
