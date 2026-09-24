import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, decodeObservationWatch, RESPONSE_MAX_BYTES, type IncidentChangeRequest } from "../src/client.ts";

const installationId = "11111111-1111-4111-8111-111111111111", databaseId = "22222222-2222-4222-8222-222222222222";
const incidentId = "33333333-3333-4333-8333-333333333333", epoch = "44444444-4444-4444-8444-444444444444";
const incidentRef = `incident:${installationId}:${databaseId}:${incidentId}`, cursor = `${databaseId}:${epoch}:0`;
const invocationId = randomUUID();
const envelope = (data: unknown) => ({ schemaVersion: 1, installationId, invocationId, ok: true, data });
const page = () => ({ source: "local-observations", coverage: "retained-events", entries: [], cursor, hasMore: false, retentionFloor: 0, gap: null,
  observationHealth: { pressureState: "normal", droppedEvents: 0, rejectedBatches: 0 } });
const request = (): IncidentChangeRequest => ({ incidentRef, requestId: randomUUID(), expectedRevision: 1, action: "ack" });
const receipt = (input: IncidentChangeRequest) => ({ version: 1, requestId: input.requestId,
  operationRef: `incident-operation:${installationId}:${databaseId}:${input.requestId}`, databaseId, incidentRef,
  action: "ack", beforeRevision: 1, appliedRevision: 2, state: "succeeded", repaired: false });
const transport = (run: () => Promise<Response> | Response): typeof fetch => Object.assign(run, { preconnect: () => undefined }) as typeof fetch;
function api(run: () => Promise<Response> | Response) {
  return new ManagementClient({ baseUrl: "http://127.0.0.1:43210", installationId, fetch: transport(run) });
}
async function consume(response: Response) {
  const values = [];
  for await (const item of decodeObservationWatch(response, { installationId, cursor, limit: 10, signal: AbortSignal.timeout(1000) })) values.push(item.data);
  return values;
}
const stream = (value: string) => new Response(value, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });

test("incident response binds the original request, target, action, database and revision", async () => {
  const input = request();
  for (const change of [{ repaired: true }, { action: "snooze" }, { beforeRevision: 5, appliedRevision: 6 }, { databaseId: randomUUID() },
    { requestId: randomUUID() }, { incidentRef: `incident:${installationId}:${databaseId}:${randomUUID()}` }, { private: "hidden-body" }]) {
    let calls = 0;
    const client = api(() => { calls++; return Response.json(envelope({ ...receipt(input), ...change })); });
    const error = await client.changeIncident(input).catch(error => error);
    expect(error.code).toBe("operation_unknown"); expect(error.details.lookupPath).toBe(`/v1/incident-operations/${databaseId}/${input.requestId}`);
    expect(calls).toBe(1);
  }
});

test("incident input snapshot survives asynchronous credential resolution and syntax errors send nothing", async () => {
  const input = request(), original = structuredClone(input);
  let release!: (token: string) => void, sent = "";
  const client = new ManagementClient({ baseUrl: "http://127.0.0.1:43210", installationId,
    credential: () => new Promise(resolve => { release = resolve; }),
    fetch: Object.assign(async (_url: unknown, init?: RequestInit) => { sent = String(init?.body); return Response.json(envelope(receipt(original))); }, { preconnect: () => undefined }) as typeof fetch });
  const pending = client.changeIncident(input); await Promise.resolve(); await Promise.resolve();
  input.requestId = randomUUID(); input.incidentRef = "changed"; release("synthetic-credential");
  expect((await pending).data.requestId).toBe(original.requestId); expect(JSON.parse(sent)).toEqual(original);
  const absent = api(() => { throw new Error("must-not-send"); });
  await expect(absent.changeIncident({ ...original, expectedRevision: 1.5 })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(absent.changeIncident({ ...original, incidentRef: `incident:${randomUUID()}:${databaseId}:${incidentId}` })).rejects.toMatchObject({ code: "wrong_installation" });
});

test("event decoder accepts fragmented UTF-8 frames only with a verified terminal cursor", async () => {
  const text = `${JSON.stringify(envelope({ kind: "page", page: page() }))}\n${JSON.stringify(envelope({ kind: "end", cursor, reason: "duration" }))}\n`;
  const bytes = new TextEncoder().encode(text); let at = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (at === bytes.length) { controller.close(); return; }
    const end = Math.min(at + 7, bytes.length); controller.enqueue(bytes.subarray(at, end)); at = end;
  } }), { headers: { "content-type": "application/x-ndjson" } });
  expect((await consume(response)).map(item => item.kind)).toEqual(["page", "end"]);
  await expect(consume(stream(`${JSON.stringify(envelope({ kind: "page", page: page() }))}\n`))).rejects.toMatchObject({ code: "unavailable", details: { cursor } });
});

test("event decoder rejects foreign identities, cursor regressions, private additions and oversized frames", async () => {
  for (const raw of [
    { ...envelope({ kind: "page", page: page() }), installationId: randomUUID() },
    envelope({ kind: "page", page: { ...page(), cursor: `${databaseId}:${randomUUID()}:0` } }),
    envelope({ kind: "end", cursor: `${databaseId}:${epoch}:1`, reason: "duration" }),
    envelope({ kind: "page", page: { ...page(), diagnostic: "private" } }),
    { ...envelope({ kind: "end", cursor, reason: "duration" }), schemaVersion: 99 },
  ]) await expect(consume(stream(`${JSON.stringify(raw)}\n`))).rejects.toMatchObject({ code: "protocol_error" });
  await expect(consume(stream(" ".repeat(RESPONSE_MAX_BYTES + 1)))).rejects.toMatchObject({ code: "protocol_error" });
  await expect(consume(new Response("{}"))).rejects.toMatchObject({ code: "protocol_error" });
});

test("event errors retain the last verified cursor; cancellation closes the body without reconnect", async () => {
  const error = { schemaVersion: 1, installationId, invocationId, ok: false, error: { code: "permission_denied", message: "Observation access was withdrawn." } };
  await expect(consume(stream(`${JSON.stringify(envelope({ kind: "page", page: page() }))}\n${JSON.stringify(error)}\n`)))
    .rejects.toMatchObject({ code: "permission_denied", details: { cursor } });
  let cancelled = 0;
  const controller = new AbortController(), response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-type": "application/x-ndjson" } });
  const next = decodeObservationWatch(response, { installationId, cursor, limit: 10, signal: controller.signal }).next();
  controller.abort(); await expect(next).rejects.toMatchObject({ code: "unavailable" }); expect(cancelled).toBe(1);
});
