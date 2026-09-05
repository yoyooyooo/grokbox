import { describe, expect, test } from "bun:test";
import { createModeld } from "../src/modeld.ts";
import type { ModelsFile } from "../src/models.ts";

const models = (overrides?: Partial<ModelsFile["assignments"]>): ModelsFile => ({
  version: 1,
  models: {
    "acme/fast": {
      id: "acme/fast",
      provider: "acme",
      model: "fast",
      endpoint: "https://api.acme.test/v1",
      apiKeyRef: "env:ACME_FAST",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    },
    "acme/smart": {
      id: "acme/smart",
      provider: "acme",
      model: "smart",
      endpoint: "https://api.acme.test/v1",
      apiKeyRef: "env:ACME_SMART",
      capabilities: { vision: true, tools: true, images: true },
      dataTypes: ["text", "tools", "images"],
    },
  },
  assignments: {
    main: "acme/fast",
    agents: { "agent-tom": "acme/smart", ...overrides?.agents },
    ...overrides,
  },
});

describe("modeld admission", () => {
  test("resolves per-bot override else main, never official on missing main", async () => {
    const driver = { calls: 0, complete() {} };
    let file = models();
    const modeld = createModeld({
      loadModels: () => file,
      getAttestation: () => ({
        generationId: "g1",
        activationId: "a1",
        pid: 1,
        start: 1,
        sourceSha: "sha",
        committed: true,
      }),
      wait: async () => true,
      now: () => 0,
      budgetMs: 20,
      resolveSecret: async (ref) => ref,
      driver,
    });
    const tom = await modeld.admit({ invocationId: "inv-tom", turnId: "turn-tom", agentId: "agent-tom" });
    const jerry = await modeld.admit({ invocationId: "inv-jerry", turnId: "turn-jerry", agentId: "agent-jerry" });
    expect(tom).toMatchObject({ ok: true, dispatched: true, modelId: "acme/smart" });
    expect(jerry).toMatchObject({ ok: true, dispatched: true, modelId: "acme/fast" });
    file = models({ main: null, agents: {} });
    const missing = await modeld.admit({ invocationId: "inv-x", turnId: "turn-x", agentId: "nobody" });
    expect(missing).toMatchObject({ ok: false, code: "missing-assignment" });
  });

  test("waits for attestation then dispatches; timeout is visible last-resort not a new default", async () => {
    const driver = { calls: 0, complete() {} };
    let clock = 0;
    const timed = createModeld({
      loadModels: () => models(),
      getAttestation: () => null,
      wait: async (ms) => {
        clock += ms;
        return true;
      },
      now: () => clock,
      budgetMs: 10,
      pollMs: 5,
      resolveSecret: async (ref) => ref,
      driver,
    });
    const burned = await timed.admit({ invocationId: "inv-wait", turnId: "turn-wait", agentId: "agent-jerry" });
    expect(burned).toMatchObject({
      ok: true,
      dispatched: false,
      lastResortOfficial: true,
      userVisible: true,
    });
    expect(driver.calls).toBe(0);
    expect(timed.officialBecameDefault()).toBe(false);

    let committed = false;
    clock = 0;
    const waiting = createModeld({
      loadModels: () => models(),
      getAttestation: () =>
        committed
          ? {
              generationId: "g1",
              activationId: "a1",
              pid: 1,
              start: 1,
              sourceSha: "sha",
              committed: true,
            }
          : null,
      wait: async (ms) => {
        clock += ms;
        committed = true;
        return true;
      },
      now: () => clock,
      budgetMs: 50,
      pollMs: 5,
      resolveSecret: async (ref) => ref,
      driver,
    });
    const ok = await waiting.admit({ invocationId: "inv-ok", turnId: "turn-ok" });
    expect(ok).toMatchObject({ ok: true, dispatched: true, modelId: "acme/fast" });
    expect(driver.calls).toBe(1);
  });

  test("pins Tom while Jerry's assignment changes; duplicate submit does not re-dispatch", async () => {
    const driver = { calls: 0, complete() {} };
    let file = models();
    const modeld = createModeld({
      loadModels: () => file,
      getAttestation: () => ({
        generationId: "g1",
        activationId: "a1",
        pid: 1,
        start: 1,
        sourceSha: "sha",
        committed: true,
      }),
      wait: async () => true,
      now: () => 0,
      budgetMs: 20,
      resolveSecret: async (ref) => `${ref}:secret`,
      driver,
    });
    const first = await modeld.admit({ invocationId: "inv-tom", turnId: "turn-tom", agentId: "agent-tom" });
    expect(first).toMatchObject({ dispatched: true, modelId: "acme/smart" });
    file = models({ agents: { "agent-tom": "acme/fast" } });
    const again = await modeld.admit({ invocationId: "inv-tom", turnId: "turn-tom", agentId: "agent-tom" });
    expect(again).toMatchObject({ dispatched: true, modelId: "acme/smart" });
    expect(driver.calls).toBe(1);
    const conflict = await modeld.admit({ invocationId: "inv-tom", turnId: "turn-other", agentId: "agent-jerry" });
    expect(conflict).toMatchObject({ ok: false, code: "conflict" });
    expect(modeld.managedFailure()).toEqual({ calledOriginalSession: false, calledSecondProvider: false });
  });

  test("disconnect marks unknown and secrets stay inside modeld", async () => {
    const seen: string[] = [];
    const driver = { calls: 0, complete() {} };
    const modeld = createModeld({
      loadModels: () => models(),
      getAttestation: () => ({
        generationId: "g1",
        activationId: "a1",
        pid: 1,
        start: 1,
        sourceSha: "sha",
        committed: true,
      }),
      wait: async () => true,
      now: () => 0,
      budgetMs: 20,
      resolveSecret: async (ref) => {
        seen.push(ref);
        return "super-secret";
      },
      driver,
    });
    const result = await modeld.admit({ invocationId: "inv-1", turnId: "turn-1" });
    expect(result).toMatchObject({ ok: true });
    if (result.ok && result.dispatched) {
      expect(result.fingerprint).not.toContain("super-secret");
    }
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(seen).toEqual(["env:ACME_FAST"]);
    const driver2 = { calls: 0, complete() {} };
    let clock = 0;
    let releaseWait: ((value: boolean) => void) | undefined;
    const running = createModeld({
      loadModels: () => models(),
      getAttestation: () => null,
      wait: async () => await new Promise<boolean>((resolve) => {
        releaseWait = resolve;
      }),
      now: () => clock,
      budgetMs: 50,
      pollMs: 5,
      resolveSecret: async (ref) => ref,
      driver: driver2,
    });
    const pending = running.admit({ invocationId: "inv-d", turnId: "turn-d" });
    for (let i = 0; i < 50 && !releaseWait; i += 1) await Bun.sleep(1);
    expect(releaseWait).toBeDefined();
    running.disconnect("inv-d");
    clock = 50;
    releaseWait?.(true);
    await pending;
    expect(running.get("inv-d")?.state).toBe("unknown");
    expect(driver2.calls).toBe(0);
  });
});
