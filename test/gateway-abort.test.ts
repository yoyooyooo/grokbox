import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createProductionDeps } from "../src/deps.ts";
import { GatewayClient } from "../src/gateway.ts";

const DISCOVERY = JSON.stringify({
  scheme: "http",
  host: "127.0.0.1",
  port: 31337,
  pid: 1,
  startedAt: 10,
  token: "test-gateway-token",
});

/**
 * A fetch stub that hangs until its `signal` aborts, then rejects with an
 * AbortError — mirroring the real `fetch` abort semantics. The stub records
 * every signal it receives and exposes a `started` promise that resolves once
 * the first fetch call is in flight, so tests can abort deterministically
 * mid-flight rather than racing on a timer.
 */
function makeHangingFetch() {
  const signals: AbortSignal[] = [];
  let count = 0;
  let startedResolve: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const fetchStub = ((_url: string | URL | Request, init?: RequestInit) => {
    count += 1;
    const signal = init?.signal as AbortSignal | undefined;
    if (signal) signals.push(signal);
    startedResolve();
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail, { once: true });
    });
  }) as typeof fetch;
  return { fetch: fetchStub, get count() { return count; }, signals, started };
}

describe("GatewayClient direct-gateway abort behavior", () => {
  test("write path (transport:local): mid-flight deps.signal abort cancels the in-flight fetch", async () => {
    const userAbort = new AbortController();
    const mock = makeHangingFetch();
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      signal: userAbort.signal,
      readFile: async () => DISCOVERY,
      fetch: mock.fetch,
    };
    const client = new GatewayClient(deps);

    const p = client.sendPrompt(
      { agentId: "a", prompt: "hi", clientNonce: randomUUID() },
      5000,
    );
    await mock.started;
    userAbort.abort();

    await expect(p).rejects.toMatchObject({ code: "send_delivery_unknown" });
    expect(mock.signals[0]?.aborted).toBe(true);
  });

  test("write path: call resolves promptly after abort, not after timeoutMs", async () => {
    const userAbort = new AbortController();
    const mock = makeHangingFetch();
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      signal: userAbort.signal,
      readFile: async () => DISCOVERY,
      fetch: mock.fetch,
    };
    const client = new GatewayClient(deps);

    const p = client.sendPrompt(
      { agentId: "a", prompt: "hi", clientNonce: randomUUID() },
      5000,
    );
    await mock.started;
    const start = Date.now();
    userAbort.abort();
    await expect(p).rejects.toMatchObject({ code: "send_delivery_unknown" });
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("discovery path (transport:auto, no daemon): mid-flight abort cancels fetch", async () => {
    const userAbort = new AbortController();
    const mock = makeHangingFetch();
    const deps = {
      ...createProductionDeps(),
      transport: "auto" as const,
      signal: userAbort.signal,
      daemonSocket: `/tmp/gbx-abort-${randomUUID()}.sock`,
      readFile: async () => DISCOVERY,
      fetch: mock.fetch,
    };
    const client = new GatewayClient(deps);

    const p = client.sendPrompt(
      { agentId: "a", prompt: "hi", clientNonce: randomUUID() },
      5000,
    );
    await mock.started;
    userAbort.abort();

    await expect(p).rejects.toMatchObject({ code: "send_delivery_unknown" });
    expect(mock.signals[0]?.aborted).toBe(true);
  });

  test("read path: mid-flight abort rejects promptly, not 2x timeoutMs", async () => {
    const userAbort = new AbortController();
    const mock = makeHangingFetch();
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      signal: userAbort.signal,
      readFile: async () => DISCOVERY,
      fetch: mock.fetch,
    };
    const client = new GatewayClient(deps);

    const p = client.listAgents(5000);
    await mock.started;
    const start = Date.now();
    userAbort.abort();
    await expect(p).rejects.toMatchObject({ code: "gateway_unreachable" });
    expect(Date.now() - start).toBeLessThan(500);

    // request() retries once on gateway_unreachable; the second sendOnce sees
    // the already-aborted signal and rejects immediately.
    expect(mock.count).toBe(2);
    expect(mock.signals[0]?.aborted).toBe(true);
    expect(mock.signals[1]?.aborted).toBe(true);
  });

  test("management write path: mid-flight abort rejects with operation_outcome_unknown", async () => {
    const userAbort = new AbortController();
    const mock = makeHangingFetch();
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      signal: userAbort.signal,
      readFile: async () => DISCOVERY,
      fetch: mock.fetch,
    };
    const client = new GatewayClient(deps);

    const p = client.createAgent({ name: "bot", description: "d" }, 5000);
    await mock.started;
    userAbort.abort();

    await expect(p).rejects.toMatchObject({ code: "operation_outcome_unknown" });
    expect(mock.signals[0]?.aborted).toBe(true);
  });

  test("SSE stream path: mid-flight abort rejects promptly via gateway_unreachable", async () => {
    const userAbort = new AbortController();
    const mock = makeHangingFetch();
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      signal: userAbort.signal,
      readFile: async () => DISCOVERY,
      fetch: mock.fetch,
    };
    const client = new GatewayClient(deps);

    const p = client.openEventStream(["agents"], 5000);
    await mock.started;
    userAbort.abort();

    await expect(p).rejects.toMatchObject({ code: "gateway_unreachable" });
    expect(mock.count).toBe(2);
    expect(mock.signals[0]?.aborted).toBe(true);
    expect(mock.signals[1]?.aborted).toBe(true);
  });

  test("pre-aborted signal: write rejects immediately with send_delivery_unknown", async () => {
    const userAbort = new AbortController();
    userAbort.abort();
    const mock = makeHangingFetch();
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      signal: userAbort.signal,
      readFile: async () => DISCOVERY,
      fetch: mock.fetch,
    };
    const client = new GatewayClient(deps);

    const start = Date.now();
    const p = client.sendPrompt(
      { agentId: "a", prompt: "hi", clientNonce: randomUUID() },
      5000,
    );
    await expect(p).rejects.toMatchObject({ code: "send_delivery_unknown" });
    expect(Date.now() - start).toBeLessThan(500);
    expect(mock.signals[0]?.aborted).toBe(true);
  });

  test("pre-aborted signal: read rejects with gateway_unreachable after a single retry", async () => {
    const userAbort = new AbortController();
    userAbort.abort();
    const mock = makeHangingFetch();
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      signal: userAbort.signal,
      readFile: async () => DISCOVERY,
      fetch: mock.fetch,
    };
    const client = new GatewayClient(deps);

    const p = client.listAgents(5000);
    await expect(p).rejects.toMatchObject({ code: "gateway_unreachable" });
    expect(mock.count).toBe(2);
    expect(mock.signals[0]?.aborted).toBe(true);
  });

  test("no deps.signal: happy-path write succeeds and fetch signal is not pre-aborted", async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchStub = ((_url: string | URL | Request, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return Promise.resolve(Response.json({ accepted: true }));
    }) as typeof fetch;
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      readFile: async () => DISCOVERY,
      fetch: fetchStub,
    };
    const client = new GatewayClient(deps);

    const result = await client.sendPrompt(
      { agentId: "a", prompt: "hi", clientNonce: randomUUID() },
      5000,
    );
    expect(result.result).toEqual({ accepted: true });
    expect(fetchSignal?.aborted).toBe(false);
  });

  test("no deps.signal: per-call timeout still aborts a hanging fetch", async () => {
    const mock = makeHangingFetch();
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      readFile: async () => DISCOVERY,
      fetch: mock.fetch,
    };
    const client = new GatewayClient(deps);

    const start = Date.now();
    const p = client.sendPrompt(
      { agentId: "a", prompt: "hi", clientNonce: randomUUID() },
      200,
    );
    await expect(p).rejects.toMatchObject({ code: "send_delivery_unknown" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2000);
    expect(mock.signals[0]?.aborted).toBe(true);
  });

  test("happy path with deps.signal: successful response is returned normally", async () => {
    const userAbort = new AbortController();
    const fetchStub = ((_url: string | URL | Request) =>
      Promise.resolve(Response.json({ accepted: true }))) as typeof fetch;
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      signal: userAbort.signal,
      readFile: async () => DISCOVERY,
      fetch: fetchStub,
    };
    const client = new GatewayClient(deps);

    const result = await client.sendPrompt(
      { agentId: "a", prompt: "hi", clientNonce: randomUUID() },
      5000,
    );
    expect(result.result).toEqual({ accepted: true });
    expect(userAbort.signal.aborted).toBe(false);
  });

  test("happy path with deps.signal: successful read returns agent list", async () => {
    const fetchStub = ((_url: string | URL | Request) =>
      Promise.resolve(Response.json([{ id: "a" }]))) as typeof fetch;
    const deps = {
      ...createProductionDeps(),
      transport: "local" as const,
      signal: new AbortController().signal,
      readFile: async () => DISCOVERY,
      fetch: fetchStub,
    };
    const client = new GatewayClient(deps);

    const result = await client.listAgents(5000);
    expect(Array.isArray(result.agents)).toBe(true);
    expect(result.agents).toHaveLength(1);
  });
});
