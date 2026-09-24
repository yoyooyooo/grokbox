import { afterEach, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelConfigurationRevision, normalizeModelProbe, parseModelProbeReceipt } from "@grokbox/runtime-kernel/model-management";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { openModelProbe, openRuntimeStore } from "../src/runtime.ts";

const INSTALLATION = "11111111-1111-4111-8111-111111111111", MODEL = "probe/local";
const PRIVATE_OUTPUT = "PROVIDER_PRIVATE_RESPONSE_FOR_PROBE_ONLY";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const allow = async () => undefined;
async function fixture(mode: "success" | "responses" | "disconnect" | "hang" | "oversized" | "redirect" = "success") {
  const root = await mkdtemp(join(tmpdir(), "grokbox-model-probe-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const received: Array<{ url: string | undefined; authorization: string | undefined; body: Record<string, unknown> }> = [];
  let arrived: () => void = () => undefined;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const data of req) body += data.toString();
    received.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    arrived();
    if (mode === "disconnect") { req.socket.destroy(); return; }
    if (mode === "hang") return;
    if (mode === "redirect") { res.writeHead(307, { location: "/redirected" }); res.end(); return; }
    if (mode === "responses") {
      const common = { id: "probe-response", model: "probe-fixture-model", object: "response", created_at: 1 };
      const message = { id: "probe-message", type: "message", role: "assistant", content: [{ type: "output_text", text: PRIVATE_OUTPUT, annotations: [] }] };
      const events = [
        { type: "response.created", response: { ...common, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
        { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: PRIVATE_OUTPUT },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: { ...common, status: "completed", output: [message],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
      return;
    }
    const content = mode === "oversized" ? "a".repeat(100000) : PRIVATE_OUTPUT;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "probe-response", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: "probe-response", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Local fixture port unavailable.");
  const env = { PROBE_FIXTURE_KEY: "synthetic-probe-secret" };
  const store = openRuntimeStore(root, {});
  await store.saveModels(parseModelsFile({ version: 3, models: { [MODEL]: {
    provider: mode === "responses" ? "openai-responses" : "openai", model: "probe-fixture-model", endpoint: `http://127.0.0.1:${address.port}/v1`, apiKeyRef: "env:PROBE_FIXTURE_KEY",
    capabilities: { vision: false, tools: false, images: false }, dataTypes: ["text"],
  } }, assignments: { main: null, agents: {} } }));
  const options = { store, installationId: INSTALLATION, principalId: "probe-fixture", env };
  const owner = openModelProbe(options);
  const request = { requestId: randomUUID(), modelId: MODEL, expectedRevision: modelConfigurationRevision(await store.loadModels()), confirmed: true };
  return { root, received, arrival, store, owner, request, env, options };
}

test("real SDK and local HTTP: one fixed bounded request, private credential lease, redacted durable receipt", async () => {
  const f = await fixture();
  const modelsBefore = await readFile(join(f.root, "models.json"), "utf8");
  const receipt = await f.owner.probe(f.request, allow);
  expect(receipt).toMatchObject({ state: "succeeded", reason: "completed", providerRequestSent: true,
    toolsExecuted: false, responseStored: false, retryAllowed: false, usage: { promptTokens: 3, completionTokens: 2 },
    cost: { mayIncur: true, amount: "unknown", maxRequests: 1, requestedMaxOutputTokens: 32 } });
  expect(receipt.outputBytes).toBe(Buffer.byteLength(PRIVATE_OUTPUT));
  expect(parseModelProbeReceipt(receipt)).toEqual(receipt);
  expect(f.received).toHaveLength(1);
  expect(f.received[0]).toMatchObject({ url: "/v1/chat/completions", authorization: "Bearer synthetic-probe-secret",
    body: { model: "probe-fixture-model", max_tokens: 32, stream: true, messages: [{ role: "system", content: "This is a connectivity probe." }, { role: "user", content: "Reply with OK." }] } });
  expect(f.received[0]?.body.tools).toBeUndefined();
  expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(modelsBefore);
  expect(await f.owner.receipt(f.request.requestId)).toEqual(receipt);
  const files = await readdir(join(f.root, "state", "model-probe-operations"));
  for (const file of files) {
    const text = await readFile(join(f.root, "state", "model-probe-operations", file), "utf8");
    expect(text).not.toContain(PRIVATE_OUTPUT);
    expect(text).not.toContain("synthetic-probe-secret");
    expect(text).not.toContain("Bearer");
  }
  await f.store.saveModels(parseModelsFile(undefined));
  const cold = openModelProbe({ ...f.options, store: { ...f.store, loadModels: async () => { throw Error("current models unavailable"); } } });
  expect(await cold.probe(f.request, allow)).toEqual(receipt);
  expect(await cold.receipt(f.request.requestId)).toEqual(receipt);
  expect(await openModelProbe({ ...f.options, principalId: "other-principal" }).receipt(f.request.requestId)).toBeUndefined();
  expect(f.received).toHaveLength(1);
});

test("Responses uses the same bounded backend and echo makes no claim of provider contact", async () => {
  const f = await fixture("responses");
  expect(await f.owner.probe(f.request, allow)).toMatchObject({ state: "succeeded", providerRequestSent: true, usage: { promptTokens: 3, completionTokens: 2 } });
  expect(f.received).toHaveLength(1);
  expect(f.received[0]).toMatchObject({ url: "/v1/responses", body: { max_output_tokens: 32, stream: true } });
  expect(f.received[0]?.body.tools).toBeUndefined();
  const echo = { ...f.request, modelId: "stub/echo", requestId: randomUUID() };
  expect(await f.owner.probe(echo, allow)).toMatchObject({ state: "succeeded", providerRequestSent: false, cost: { mayIncur: false, amount: "none" } });
  expect(f.received).toHaveLength(1);
});

test("confirmation, UUID, unsupported fields, revision and missing credentials refuse before any external request", async () => {
  const f = await fixture();
  for (const input of [{ ...f.request, confirmed: false }, { ...f.request, requestId: "bad" }, { ...f.request, prompt: "custom input" },
    { ...f.request, timeoutMs: 99 }, { ...f.request, timeoutMs: 30001 }]) {
    expect(() => normalizeModelProbe(input)).toThrow();
  }
  await expect(f.owner.probe({ ...f.request, expectedRevision: "0".repeat(64) }, allow)).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(openModelProbe({ ...f.options, env: {} }).probe(f.request, allow)).rejects.toBeDefined();
  await expect(f.owner.probe(f.request, async () => { throw Error("permission revoked"); })).rejects.toThrow("permission revoked");
  expect(f.received).toHaveLength(0);
  expect(await f.owner.receipt(f.request.requestId)).toBeUndefined();
});

test("a lost provider response remains unknown across new owners, changed revisions and replacement UUIDs", async () => {
  const f = await fixture("disconnect");
  const first = await f.owner.probe(f.request, allow);
  expect(first).toMatchObject({ state: "unknown", providerRequestSent: true, reason: "outcome-unknown", retryAllowed: false });
  const cold = openModelProbe(f.options);
  expect(await cold.probe(f.request, allow)).toEqual(first);
  await expect(cold.probe({ ...f.request, requestId: randomUUID() }, allow)).rejects.toMatchObject({ code: "operation_unknown" });
  await expect(cold.probe({ ...f.request, timeoutMs: 20000 }, allow)).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(f.received).toHaveLength(1);
});

test("timeout aborts its original stream without resending or retaining the response", async () => {
  const f = await fixture("hang");
  const request = { ...f.request, timeoutMs: 300 };
  const before = performance.now();
  const receipt = await f.owner.probe(request, allow);
  expect(performance.now() - before).toBeLessThan(3000);
  expect(receipt).toMatchObject({ state: "unknown", providerRequestSent: true, retryAllowed: false });
  expect(await f.owner.probe(request, allow)).toEqual(receipt);
  expect(f.received).toHaveLength(1);
});

test("caller cancellation settles the same durable request without allowing another fetch", async () => {
  const f = await fixture("hang"), abort = new AbortController();
  const pending = f.owner.probe(f.request, allow, abort.signal);
  await f.arrival; abort.abort();
  const receipt = await pending;
  expect(receipt).toMatchObject({ state: "unknown", providerRequestSent: true });
  expect(await f.owner.probe(f.request, allow)).toEqual(receipt);
  expect(f.received).toHaveLength(1);
});

test("permission, configuration and credential changes at the actual fetch boundary send nothing", async () => {
  for (const change of ["permission", "configuration", "credential"]) {
    const f = await fixture();
    let checks = 0;
    const receipt = await f.owner.probe(f.request, async () => {
      if (++checks !== 3) return;
      if (change === "permission") throw Error("permission revoked");
      if (change === "credential") f.env.PROBE_FIXTURE_KEY = "rotated-private-secret";
      if (change === "configuration") await f.store.saveModels(parseModelsFile(undefined));
    });
    expect(receipt).toMatchObject({ state: "failed", providerRequestSent: false, reason: "not-dispatched", cost: { mayIncur: false, amount: "none" } });
    expect(f.received).toHaveLength(0);
    expect(await f.owner.probe(f.request, allow)).toEqual(receipt);
  }
});

test("concurrent submissions of the same request have one external effect", async () => {
  const f = await fixture("hang");
  const first = f.owner.probe({ ...f.request, timeoutMs: 300 }, allow);
  await f.arrival;
  const duplicate = await openModelProbe(f.options).probe({ ...f.request, timeoutMs: 300 }, allow);
  expect(duplicate).toMatchObject({ state: "unknown", providerRequestSent: null });
  expect(await first).toMatchObject({ state: "unknown", providerRequestSent: true });
  expect(f.received).toHaveLength(1);
});

test("redirects and oversized streams cannot turn one probe into extra requests or unbounded response reads", async () => {
  for (const mode of ["redirect", "oversized"] as const) {
    const f = await fixture(mode);
    const receipt = await f.owner.probe(f.request, allow);
    expect(receipt).toMatchObject({ state: "unknown", providerRequestSent: true, retryAllowed: false });
    expect(receipt.outputBytes).toBeLessThanOrEqual(65536);
    expect(f.received).toHaveLength(1);
    expect(await f.owner.probe(f.request, allow)).toEqual(receipt);
  }
});

test("SIGKILL after the provider accepted the request retains an unknown guard in a fresh process", async () => {
  const f = await fixture("hang");
  const worker = spawn(process.execPath, [join(import.meta.dir, "fixtures", "model-probe-worker.node.ts"), f.root, JSON.stringify(f.request)], { stdio: "ignore" });
  const exited = new Promise<void>((resolve, reject) => { worker.once("exit", () => resolve()); worker.once("error", reject); });
  cleanup.push(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); await exited; });
  await Promise.race([f.arrival, exited.then(() => { throw Error("Worker exited before the fixture provider request."); })]);
  worker.kill("SIGKILL"); await exited;
  const cold = openModelProbe(f.options);
  const retained = await cold.receipt(f.request.requestId);
  if (!retained) throw Error("Original probe declaration was not retained.");
  expect(retained).toMatchObject({ state: "unknown", providerRequestSent: null, finishedAt: null, retryAllowed: false });
  expect(await cold.probe(f.request, allow)).toEqual(retained);
  await expect(cold.probe({ ...f.request, requestId: randomUUID() }, allow)).rejects.toMatchObject({ code: "operation_unknown" });
  expect(f.received).toHaveLength(1);
}, 10000);

test("malformed persisted evidence blocks new work and is never interpreted as permission to replay", async () => {
  const f = await fixture();
  await f.owner.probe(f.request, allow);
  const directory = join(f.root, "state", "model-probe-operations");
  const files = await readdir(directory);
  const file = files.find(value => value.endsWith(".json")); if (!file) throw Error("Missing durable receipt.");
  await writeFile(join(directory, file), JSON.stringify({ version: 1, fingerprint: "a".repeat(64), receipt: { state: "succeeded", secret: "bad" } }), { mode: 0o600 });
  await expect(f.owner.probe(f.request, allow)).rejects.toMatchObject({ code: "unavailable" });
  await expect(f.owner.probe({ ...f.request, requestId: randomUUID() }, allow)).rejects.toMatchObject({ code: "unavailable" });
  expect(f.received).toHaveLength(1);
});

test("the owning Scope joins a late fetch and its response-body cancellation after SDK interruption", async () => {
  const f = await fixture(), requested = Promise.withResolvers<void>(), headers = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  let calls = 0, settled = false;
  const fetchLate: typeof fetch = Object.assign(async () => {
    calls++; requested.resolve(); await headers.promise;
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelling.resolve(); return released.promise; } }),
      { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: fetch.preconnect });
  const owner = openModelProbe({ ...f.options, fetch: fetchLate });
  const fiber = Effect.runFork(owner.effect(f.request, allow));
  let closing: Promise<unknown> | undefined;
  try {
    await requested.promise;
    closing = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false);
    headers.resolve(); await cancelling.promise;
    expect(settled).toBe(false);
    released.resolve(); await closing;
    expect(calls).toBe(1); expect(f.received).toHaveLength(0);
    expect(await owner.receipt(f.request.requestId)).toMatchObject({ state: "unknown", providerRequestSent: true, retryAllowed: false });
  } finally { headers.resolve(); released.resolve(); await closing; await Effect.runPromise(Fiber.interrupt(fiber)); }
}, 10000);

for (const mode of ["oversized", "malformed", "cancelled"] as const) test(`probe Scope joins returned ${mode} body cancellation`, async () => {
  const f = await fixture(), requested = Promise.withResolvers<void>(), cancelling = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  let calls = 0, cancelDone = false, settled = false;
  const source: typeof fetch = Object.assign(async () => {
    calls++; requested.resolve();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "oversized") controller.enqueue(new Uint8Array(70000).fill(65));
        if (mode === "malformed") controller.enqueue(new TextEncoder().encode("data: {invalid-json}\n\n"));
      },
      async cancel() { cancelling.resolve(); await released.promise; cancelDone = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: fetch.preconnect });
  const owner = openModelProbe({ ...f.options, fetch: source });
  const fiber = Effect.runFork(owner.effect(f.request, allow));
  let closing: Promise<unknown> | undefined;
  try {
    await requested.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    if (mode !== "cancelled") await cancelling.promise;
    closing = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { settled = true; });
    await cancelling.promise;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(settled).toBe(false); expect(cancelDone).toBe(false);
    released.resolve(); await closing;
    expect(cancelDone).toBe(true); expect(calls).toBe(1); expect(f.received).toHaveLength(0);
    expect(await owner.receipt(f.request.requestId)).toMatchObject({ state: "unknown", retryAllowed: false });
  } finally { released.resolve(); await closing; await Effect.runPromise(Fiber.interrupt(fiber)); }
}, 10000);

test("body cancellation failure is an explicit cleanup gap and retains the uncertain request guard", async () => {
  const f = await fixture(); let calls = 0;
  const source: typeof fetch = Object.assign(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(70000).fill(65)); },
      cancel() { return Promise.reject(Error("fixture cancellation failed")); },
    }), { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: fetch.preconnect });
  const owner = openModelProbe({ ...f.options, fetch: source });
  await expect(Effect.runPromise(owner.effect(f.request, allow))).rejects.toThrow("model_probe_body_cleanup_gap");
  expect(await owner.receipt(f.request.requestId)).toMatchObject({ state: "unknown", retryAllowed: false });
  await expect(owner.probe({ ...f.request, requestId: randomUUID() }, allow)).rejects.toMatchObject({ code: "operation_unknown" });
  expect(calls).toBe(1); expect(f.received).toHaveLength(0);
});

test("an already-errored upstream body settles unknown without inventing a cancellation cleanup gap", async () => {
  const f = await fixture(); let calls = 0, cancellations = 0;
  const source: typeof fetch = Object.assign(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { queueMicrotask(() => controller.error(Error("fixture transport failed after headers"))); },
      cancel() { cancellations++; throw Error("an errored stream cannot reach underlying cancellation"); },
    }), { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: fetch.preconnect });
  const owner = openModelProbe({ ...f.options, fetch: source });
  const receipt = await Effect.runPromise(owner.effect(f.request, allow));
  expect(receipt).toMatchObject({ state: "unknown", providerRequestSent: true, retryAllowed: false });
  expect(calls).toBe(1); expect(cancellations).toBe(0); expect(f.received).toHaveLength(0);
});
