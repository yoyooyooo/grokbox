import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, normalizeNotificationSend, type NotificationSendRequest, type NotificationSendOperation } from "../src/client.ts";
const I = "11111111-1111-4111-8111-111111111111", D = "22222222-2222-4222-8222-222222222222", B = "33333333-3333-4333-8333-333333333333", H = "a".repeat(64);
const request = (): NotificationSendRequest => ({ notificationRef: `notification:${I}:${D}:${B}`, receiverRef: `receiver:${I}:${D}:${B}`,
  requestId: randomUUID(), expectedRevision: 1, expectedModelRevision: H, confirmed: true });
function result(input: NotificationSendRequest): NotificationSendOperation {
  return { version: 1, operationRef: `notification-operation:${I}:${D}:${H}`, requestId: input.requestId,
    notificationRef: input.notificationRef, receiverRef: input.receiverRef, action: "send", expectedRevision: 1, expectedModelRevision: H,
    state: "refused", reason: "not-dispatched", attempt: null, enablesAutomatic: false, botReport: "not_observed", userRead: "not_observed" };
}

test("send grammar rejects getters, inherited/hidden fields, symbols and free payload before resolving any authority", async () => {
  let reads = 0, calls = 0;
  const client = new ManagementClient({ baseUrl: "http://127.0.0.1:3333", installationId: I, credential: async () => { reads++; return "synthetic"; },
    fetch: (async () => { calls++; throw Error("no-network"); }) as never });
  const input = request(), getter = { ...input };
  Object.defineProperty(getter, "expectedRevision", { enumerable: true, get() { reads++; return 1; } });
  const hidden = { ...input }; Object.defineProperty(hidden, "confirmed", { value: true, enumerable: false });
  const candidates = [getter, hidden, Object.create(input), { ...input, [Symbol("private")]: true }, { ...input, body: "run tools" },
    { ...input, expectedRevision: "1" }, { ...input, confirmed: false }, { ...input, expectedModelRevision: "invalid" },
    { ...input, receiverRef: input.receiverRef.replace(D, B) }];
  for (const candidate of candidates) await expect(client.sendNotification(candidate as never)).rejects.toMatchObject({ code: "invalid_input" });
  expect(reads).toBe(0); expect(calls).toBe(0);
  const parsed = normalizeNotificationSend(input, I); input.expectedRevision = 9; expect(parsed.expectedRevision).toBe(1);
});

test("lost transport preserves the original detached request and exact lookup without an automatic retry", async () => {
  const input = request(), original = structuredClone(input); let calls = 0, sent: unknown, release!: (v: string) => void;
  const client = new ManagementClient({ baseUrl: "http://127.0.0.1:3333", installationId: I,
    credential: () => new Promise(resolve => { release = resolve; }), fetch: (async (_url: unknown, init?: RequestInit) => {
      calls++; sent = JSON.parse(init!.body as string); throw Error("lost-ack");
    }) as never });
  const pending = client.sendNotification(input); await Promise.resolve();
  input.requestId = randomUUID(); input.expectedModelRevision = "b".repeat(64); release("synthetic");
  await expect(pending).rejects.toMatchObject({ code: "operation_unknown", details: { requestId: original.requestId,
    lookupPath: `/v1/notification-send-operations/${D}/${original.requestId}` } });
  expect(sent).toEqual(original); expect(calls).toBe(1);
});

for (const refused of [false, true]) test(`successful transport and refused replies both bind the original work, receiver and approval, refused=${refused}`, async () => {
  const input = request(), valid = result(input);
  const client = (value: unknown) => new ManagementClient({ baseUrl: "http://127.0.0.1:3333", installationId: I,
    fetch: (async () => Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: !refused,
      ...(refused ? { error: { code: "notification_send_refused", message: "not sent", details: { operation: value } } } : { data: value }) }, { status: refused ? 409 : 200 })) as never });
  for (const patch of [{ requestId: randomUUID() }, { receiverRef: valid.receiverRef.replace(B, randomUUID()) },
    { notificationRef: valid.notificationRef.replace(B, randomUUID()) }, { expectedModelRevision: "b".repeat(64) },
    { expectedRevision: 2 }, { state: "succeeded" }, { enablesAutomatic: true }, { userRead: "read" },
    { operationRef: valid.operationRef + ":other" }, { nativeBody: "secret" }]) {
    await expect(client({ ...valid, ...patch }).sendNotification(input)).rejects.toMatchObject({ code: "operation_unknown" });
  }
  if (refused) await expect(client(valid).sendNotification(input)).rejects.toMatchObject({ code: "notification_send_refused" });
  else expect((await client(valid).sendNotification(input)).data).toEqual(valid);
});

test("historical receipt validation cannot turn a reserved attempt into accepted or hide a missing settlement", async () => {
  const input = request(), value = result(input);
  const attempt = { attemptId: B, state: "reserved" as const, targetAgentId: B, bindingRevision: 1, envelopeDigest: H, envelopeBytes: 200, reservedAtMs: 2, settledAtMs: null };
  for (const candidate of [{ ...value, attempt, reason: null, state: "succeeded" },
    { ...value, attempt: { ...attempt, state: "native-accepted" }, reason: null, state: "succeeded" },
    { ...value, attempt, state: "unknown" }]) {
    const client = new ManagementClient({ baseUrl: "http://127.0.0.1:3333", installationId: I,
      fetch: (async () => Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: true, data: candidate })) as never });
    await expect(client.notificationSendOperation(D, input.requestId)).rejects.toMatchObject({ code: "protocol_error" });
  }
});
