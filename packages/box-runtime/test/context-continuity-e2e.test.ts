import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectStreamParts } from "./host-consumer.ts";
import {
  asHostPromptSession,
  createStreamingPromptSession,
} from "./packed-host-session.ts";
import { runAuxiliary } from "../src/internal/host/auxiliary.ts";
import { BoxRuntimeError, ENVELOPE_MAX_BYTES, SNAPSHOT_JSON_MAX_BYTES } from "@grokbox/runtime-kernel/contract";
import { computeSelectionRevision, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import {
  ARCHIVED_ONLY,
  assertIndependentGoldenInHttp,
  assertNoCapStoreOrDecoy,
  compactJourneyWindow,
  createHostMemoryControl,
  createHostOutputConsumer,
  createHostSummaryControl,
  END_SENTINEL,
  FACT_ALPHA,
  HOST_P_USED,
  HOST_S_USED,
  hostAcceptSummary,
  longZeroCapWindow,
  LOOKUP_TOOL,
  metadataWindow,
  PAD_BODY,
  padWindow,
  publishHostRoot,
  readHostRoot,
  sha256Json,
  SYNTHETIC_OPENAI,
  SYNTHETIC_OPENAI_NO_WINDOW,
  SYNTHETIC_W,
  TOOL_BODY,
  UI_DECOY,
  UNICODE_SENTINEL,
  utf8JsonBytes,
  withFakeHttpSession,
  writeHostRoot,
  writeUiDecoy,
} from "./context-continuity-fixture.ts";

const WORKER = fileURLToPath(new URL("./context-continuity-reload-worker.ts", import.meta.url));

async function runWorker(scenario: string, storePath: string): Promise<Record<string, unknown>> {
  const resultPath = join(dirname(storePath), "worker-result.json");
  const proc = Bun.spawn(["bun", WORKER, scenario, storePath, resultPath], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exit, `${stderr}\n${stdout}`).toBe(0);
  return JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
}

describe("E01 factory + state law (unix STEP fence)", () => {
  test("E01 factory + state law: duplicate STEP does not repeat provider effect", async () => {
    const window = metadataWindow().filter((message) => message.role !== "system");
    await withFakeHttpSession({
      turnId: "HOST_TURN_E01",
      fn: async ({ session, requests }) => {
        const a = session.getExecutor(window);
        const b = session.getExecutor(window);
        expect(a).not.toBe(b);
        await a.stream({}, "same-step", [LOOKUP_TOOL]).response;
        const second = b.stream({}, "same-step", [LOOKUP_TOOL]);
        await second.response.catch(() => undefined);
        expect(requests).toHaveLength(1);
        expect(a.getState()).toEqual(window);
        expect(b.getState()).toEqual(window);
      },
    });
  }, 15_000);
});

describe("E03 zero-CAP long window", () => {
  test("E03 zero-CAP long window matches independent golden HTTP", async () => {
    expect(process.env.GROKBOX_CONTEXT_CAP).toBeUndefined();
    const { window, bytes } = longZeroCapWindow();
    expect(window.length).toBeGreaterThanOrEqual(600);
    expect(bytes).toBeGreaterThanOrEqual(256 * 1024);
    await withFakeHttpSession({
      turnId: "HOST_TURN_E03",
      inspect: (body, text) => {
        if (!text.includes("E03-EARLY-SENTINEL")) throw new Error("mock missing early sentinel");
        if (!text.includes("E03-MID-SENTINEL")) throw new Error("mock missing mid sentinel");
        if (!text.includes(END_SENTINEL)) throw new Error("mock missing end sentinel");
        if (!text.includes(UNICODE_SENTINEL)) throw new Error("mock missing unicode");
        if (!text.includes(PAD_BODY.slice(0, 64))) throw new Error("mock missing pad");
        if (!text.includes(TOOL_BODY)) throw new Error("mock missing tool tail");
        if (!text.includes("user-contained-result")) throw new Error("mock missing user-contained result");
        if (text.includes(UI_DECOY)) throw new Error("mock saw UI decoy");
        if (text.includes("store.db")) throw new Error("mock saw store.db");
        void body;
      },
      fn: async ({ session, requests, dir }) => {
        await writeUiDecoy(dir);
        const executor = session.getExecutor(window);
        const handle = executor.stream({}, "step-e03", [LOOKUP_TOOL]);
        const parts = await collectStreamParts(handle.fullStream);
        await handle.response;
        expect(parts.some((part) => part.type === "text-delta")).toBe(true);
        expect(requests).toHaveLength(1);
        assertIndependentGoldenInHttp(requests[0]!.body, window);
        assertNoCapStoreOrDecoy(requests[0]!.body);
        expect(executor.getState()).toEqual(window);
        expect(requests[0]!.text).toContain(TOOL_BODY.slice(-32));
        expect(requests[0]!.text).not.toContain(UI_DECOY);
      },
    });
  }, 60_000);
});

describe("E04 Host legal compact → reload", () => {
  test("E04 Host compact carrier survives owned-store reload", async () => {
    const selected = compactJourneyWindow();
    const compacted = hostAcceptSummary(selected, 1);
    expect(compacted.window.some((message) => message.isSummary === true)).toBe(true);
    expect(compacted.archive.some((message) => typeof message.content === "string" && message.content.includes(ARCHIVED_ONLY))).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "grokbox-ctx-e04-"));
    const store = join(dir, "host-window-root.json");
    await writeHostRoot(store, compacted.window as unknown[], compacted.archive);
    await writeUiDecoy(dir);
    const result = await runWorker("compact-next-turn", store);
    expect(result.ok).toBe(true);
    expect(result.pid).not.toBe(process.pid);
    expect(result.httpCount).toBe(1);
    expect(result.diskSha).toBe(sha256Json(compacted.window));
    const state = result.state as Array<{ isSummary?: boolean; providerOptions?: { cursor?: { userInfoSummarizationEpoch?: number } } }>;
    expect(state[0]?.isSummary).toBe(true);
    expect(state[0]?.providerOptions?.cursor?.userInfoSummarizationEpoch).toBe(1);
    const http = String(result.httpText ?? "");
    expect(http).toContain(compacted.summaryText);
    expect(http).toContain(FACT_ALPHA);
    expect(http).toContain("TAIL-KEEP-AFTER-COMPACT");
    expect(http).not.toContain(ARCHIVED_ONLY);
    expect(http).not.toContain(UI_DECOY);
    expect(http).not.toContain("store.db");
    expect(result.decoyPresent).toBe(false);
  }, 30_000);
});

function windowRows() {
  return metadataWindow().filter((message) => message.role !== "system");
}

describe("E05 W/U feedback through Host extendedUsage", () => {
  const cases: Array<{ used: number; phase: "mid-loop" | "turn-tail" }> = [
    { used: 179999, phase: "mid-loop" },
    { used: 179999, phase: "turn-tail" },
    { used: HOST_S_USED, phase: "mid-loop" },
    { used: HOST_S_USED, phase: "turn-tail" },
    { used: HOST_P_USED, phase: "mid-loop" },
    { used: HOST_P_USED, phase: "turn-tail" },
  ];
  test.each(cases)("E05 W/U used=$used phase=$phase", async ({ used, phase }) => {
    const output = 20;
    const cacheRead = 12;
    await withFakeHttpSession({
      turnId: `HOST_TURN_E05_${used}_${phase}`,
      usage: {
        prompt_tokens: used - output,
        completion_tokens: output,
        total_tokens: used,
        cache_read_tokens: cacheRead,
        cache_write_tokens: 3,
      },
      fn: async ({ session, requests, dir }) => {
        const selected = windowRows();
        const store = join(dir, "host-window-root.json");
        const initial = await writeHostRoot(store, selected as unknown[]);
        const summary = createHostSummaryControl(selected);
        const executor = session.getExecutor(selected);
        const handle = executor.stream({}, `step-e05-${used}-${phase}`, [LOOKUP_TOOL]);
        const extended = await handle.extendedUsage;
        expect(extended.maxTokens).toBe(SYNTHETIC_W);
        expect(extended.maxTokens).not.toBe(0);
        expect(extended.maxTokens).not.toBe(extended.outputTokens);
        expect(extended.inputTokens).toBe(used - output);
        expect(extended.outputTokens).toBe(output);
        expect(extended.cacheReadTokens).toBe(cacheRead);
        const body = requests[0]?.body as { max_tokens?: unknown } | undefined;
        if (typeof body?.max_tokens === "number") expect(extended.maxTokens).not.toBe(body.max_tokens);
        const observed = summary.observe(extended);
        expect(observed.W).toBe(SYNTHETIC_W);
        expect(observed.U).toBe(used);
        expect(observed.started).toBe(used >= HOST_S_USED);
        expect(observed.persist).toBe(used >= HOST_P_USED);
        expect(() => summary.accept(phase)).toThrow("summary-incomplete");
        expect((await readHostRoot(store)).refs.sha256).toBe(initial.refs.sha256);
        summary.release();
        await summary.wait();
        const mayAccept = phase === "mid-loop" ? observed.started : observed.persist;
        if (!mayAccept) {
          expect(() => summary.accept(phase)).toThrow("summary-not-acceptable");
          expect(summary.accepted).toBe(false);
          expect((await readHostRoot(store)).refs.sha256).toBe(initial.refs.sha256);
        } else {
          const accepted = summary.accept(phase);
          expect(summary.accepted).toBe(true);
          expect(accepted.some((message) => message.isSummary === true)).toBe(true);
          expect((await readHostRoot(store)).refs.sha256).toBe(initial.refs.sha256);
          await summary.checkpoint(store);
          const after = await readHostRoot(store);
          expect(after.refs.sha256).not.toBe(initial.refs.sha256);
          expect(after.state.some((message) => (message as { isSummary?: boolean }).isSummary === true)).toBe(true);
        }
        expect(executor.getState()).toEqual(selected);
        await handle.response;
      },
    });
  }, 20_000);
});

describe("E06 unknown window/usage and pinned selection", () => {
  test("E06 missing window is not a qualified success and does not chop", async () => {
    await withFakeHttpSession({
      turnId: "HOST_TURN_E06_missing",
      model: SYNTHETIC_OPENAI_NO_WINDOW,
      fn: async ({ session, requests }) => {
        const window = windowRows();
        const executor = session.getExecutor(window);
        await expect(executor.stream({}, "step-e06-missing", [LOOKUP_TOOL]).response).rejects.toMatchObject({
          name: "RetriableError",
        });
        expect(requests).toHaveLength(0);
        expect(executor.getState()).toEqual(window);
      },
    });
  }, 20_000);

  test("E06 0/negative/non-integer windows fail closed at parse", () => {
    for (const contextWindowTokens of [0, -1, 1.5, Number.NaN]) {
      expect(() => parseModelsFile({
        version: 3,
        models: { [SYNTHETIC_OPENAI.id]: { ...SYNTHETIC_OPENAI, contextWindowTokens } },
        assignments: { main: null, agents: { "agent-tom": { modelId: SYNTHETIC_OPENAI.id } } },
      })).toThrow(BoxRuntimeError);
    }
  });

  test("E06 unknown usage does not settle 0/0 success", async () => {
    await withFakeHttpSession({
      turnId: "HOST_TURN_E06_nousage",
      usage: "omit",
      fn: async ({ session }) => {
        const handle = session.getExecutor(windowRows()).stream({}, "step-e06-nousage", [LOOKUP_TOOL]);
        await expect(handle.response).rejects.toBeDefined();
        await expect(handle.usage).rejects.toBeDefined();
        await expect(handle.extendedUsage).rejects.toBeDefined();
      },
    });
  }, 20_000);

  test("E06 next TURN smaller window does not rewrite a live TURN", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const narrow = { ...SYNTHETIC_OPENAI, contextWindowTokens: 32000 };
    const liveRev = computeSelectionRevision({ agentId: "agent-tom", model: SYNTHETIC_OPENAI });
    const nextRev = computeSelectionRevision({ agentId: "agent-tom", model: narrow });
    expect(liveRev).not.toBe(nextRev);
    await withFakeHttpSession({
      turnId: "HOST_TURN_E06_live",
      hold,
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      fn: async ({ session, makeSession, requests, admitted, updateCanonicalModel }) => {
        const selected = windowRows();
        const live = session.getExecutor(selected);
        const pending = live.stream({}, "step-e06-live", [LOOKUP_TOOL]);
        await admitted;
        expect(requests).toHaveLength(1);
        updateCanonicalModel(narrow);
        const next = makeSession({ turnId: "HOST_TURN_E06_next", model: narrow, contextWindowTokens: 32000 });
        const whileHeld = next.getExecutor(selected).stream({}, "step-e06-next-held", [LOOKUP_TOOL]);
        const early = await Promise.race([
          whileHeld.response.then(() => "resolved" as const, () => "refused" as const),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 80)),
        ]);
        expect(live.getState()).toEqual(selected);
        release();
        const liveUsage = await pending.extendedUsage;
        expect(liveUsage.maxTokens).toBe(SYNTHETIC_W);
        await pending.response;
        expect(live.getState()).toEqual(selected);
        if (early === "refused") {
          const after = next.getExecutor(selected).stream({}, "step-e06-next", [LOOKUP_TOOL]);
          expect(await after.extendedUsage).toMatchObject({ maxTokens: 32000 });
          await after.response;
        } else {
          expect(await whileHeld.extendedUsage).toMatchObject({ maxTokens: 32000 });
          if (early === "pending") await whileHeld.response;
        }
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(live.getState()).toEqual(selected);
      },
    });
  }, 30_000);
});

describe("E08 budget/cancel/fault", () => {
  const SNAPSHOT_NEAR_PAD = SNAPSHOT_JSON_MAX_BYTES - 65_536;
  const SNAPSHOT_OVER_PAD = SNAPSHOT_JSON_MAX_BYTES + 8_192;

  test("E08 near-snapshot-boundary success does not chop; reopen reads committed root", async () => {
    const window = padWindow("near-snap", SNAPSHOT_NEAR_PAD);
    const selectedBytes = utf8JsonBytes(window);
    expect(selectedBytes).toBeGreaterThan(SNAPSHOT_JSON_MAX_BYTES - 80_000);
    expect(selectedBytes).toBeLessThan(SNAPSHOT_JSON_MAX_BYTES);
    expect(selectedBytes).toBeLessThan(ENVELOPE_MAX_BYTES);
    await withFakeHttpSession({
      turnId: "HOST_TURN_E08_near",
      // This vector tests transport/root byte bounds, not the default 128K policy.
      // Declare a large local window and model capacity; never bypass the budget gate.
      model: { ...SYNTHETIC_OPENAI, contextWindowTokens: 2097152 },
      context: { windowTokens: 2097152 },
      fn: async ({ session, requests, dir }) => {
        const store = join(dir, "host-window-root.json");
        const executor = session.getExecutor(window);
        await executor.stream({}, "step-e08-near", [LOOKUP_TOOL]).response;
        expect(requests).toHaveLength(1);
        const encoded = utf8JsonBytes(requests[0]!.body);
        expect(encoded).toBeGreaterThan(SNAPSHOT_JSON_MAX_BYTES - 80_000);
        expect(encoded).toBeLessThan(8 * 1024 * 1024);
        assertIndependentGoldenInHttp(requests[0]!.body, window);
        assertNoCapStoreOrDecoy(requests[0]!.body);
        expect(executor.getState()).toEqual(window);
        const committed = await publishHostRoot(store, executor.getState() as unknown[]);
        const reopened = await runWorker("reopen-state", store);
        expect(reopened.ok).toBe(true);
        expect(reopened.pid).not.toBe(process.pid);
        expect(reopened.diskSha).toBe(committed.refs.sha256);
        expect(reopened.state).toEqual(window);
      },
    });
  }, 90_000);

  test("E08 over-snapshot and over-envelope refuse; getter checkpoint does not publish empty", async () => {
    const legal = windowRows();
    await withFakeHttpSession({
      turnId: "HOST_TURN_E08_over",
      fn: async ({ session, requests, dir }) => {
        const store = join(dir, "host-window-root.json");
        const prior = await publishHostRoot(store, legal as unknown[]);
        const overSnap = padWindow("over-snap", SNAPSHOT_OVER_PAD);
        expect(utf8JsonBytes(overSnap)).toBeGreaterThan(SNAPSHOT_JSON_MAX_BYTES);
        expect(utf8JsonBytes(overSnap)).toBeLessThan(ENVELOPE_MAX_BYTES);
        const snapEx = session.getExecutor(overSnap);
        await expect(snapEx.stream({}, "step-e08-over-snap", [LOOKUP_TOOL]).response).rejects.toMatchObject({
          name: "RetriableError",
        });
        const snapState = snapEx.getState();
        expect(Array.isArray(snapState) ? snapState.length : 0).not.toBe(0);
        await publishHostRoot(store, snapState as unknown[]);
        expect((await readHostRoot(store)).state).toEqual(overSnap);
        const overSnapReopen = await runWorker("reopen-state", store);
        expect(overSnapReopen.state).toEqual(overSnap);
        const overEnv = [{ role: "user" as const, content: "x".repeat(ENVELOPE_MAX_BYTES + 1) }];
        const envEx = session.getExecutor(overEnv);
        await expect(envEx.stream({}, "step-e08-over-env", [LOOKUP_TOOL]).response).rejects.toMatchObject({
          name: "RetriableError",
        });
        let envState: unknown;
        try { envState = envEx.getState(); } catch { envState = { threw: true }; }
        if (envState && typeof envState === "object" && "threw" in envState) {
          expect((await readHostRoot(store)).state).toEqual(overSnap);
          const refused = await runWorker("reopen-state", store);
          expect(refused.state).toEqual(overSnap);
        } else {
          expect(envState).toEqual(overEnv);
          await publishHostRoot(store, envState as unknown[]);
          const envReopen = await runWorker("reopen-state", store);
          expect(envReopen.state).toEqual(overEnv);
          expect(envReopen.pid).not.toBe(process.pid);
        }
        expect(requests).toHaveLength(0);
      },
    });
  }, 60_000);

  test("E08 cancel error-checkpoint keeps full prior, not empty", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const selected = windowRows();
    await withFakeHttpSession({
      turnId: "HOST_TURN_E08_cancel",
      hold,
      fn: async ({ session, requests, dir, admitted }) => {
        const store = join(dir, "host-window-root.json");
        await publishHostRoot(store, selected as unknown[]);
        const executor = session.getExecutor(selected);
        const ac = new AbortController();
        const handle = executor.stream({ signal: ac.signal }, "step-e08-cancel", [LOOKUP_TOOL]);
        await admitted;
        ac.abort();
        await handle.response.then(() => undefined, () => undefined);
        release();
        const after = executor.getState();
        expect(after).toEqual(selected);
        expect(Array.isArray(after) ? after.length : 0).not.toBe(0);
        await publishHostRoot(store, after as unknown[]);
        const reopened = await runWorker("reopen-state", store);
        expect(reopened.state).toEqual(selected);
        expect(reopened.pid).not.toBe(process.pid);
        expect(requests.length).toBeLessThanOrEqual(1);
      },
    });
  }, 20_000);

  test("E08 late retired STEP does not duplicate tool or delivery effects", async () => {
    let releaseOld!: () => void;
    const oldHold = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldAtHold!: () => void;
    const oldHeld = new Promise<void>((resolve) => { oldAtHold = resolve; });
    const consumer = createHostOutputConsumer();
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: SYNTHETIC_OPENAI.id,
      vision: false,
      parallel: "allow",
      produce: async function* (request) {
        const step = typeof request.invocationId === "string" ? request.invocationId : "unknown";
        yield { type: "text-delta" as const, textDelta: `text-${step}` };
        if (step === "step-e08-old") {
          oldAtHold();
          await oldHold;
        }
        yield { type: "tool-call" as const, toolCallId: `call-${step}`, toolName: "lookup", args: { q: step } };
        yield { type: "finish" as const, reason: "stop" as const, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    }), SYNTHETIC_OPENAI.id, undefined, { requireStepId: true, contextWindowTokens: SYNTHETIC_W });
    const oldWindow = [{ role: "user" as const, content: "old-window" }];
    const mainWindow = [{ role: "user" as const, content: "main-only-window" }];
    const oldEx = session.getExecutor(oldWindow);
    const mainEx = session.getExecutor(mainWindow);
    const oldHandle = oldEx.stream({}, "step-e08-old", [LOOKUP_TOOL]);
    const oldConsume = consumer.consume("step-e08-old", oldHandle);
    await oldHeld;
    consumer.retire("step-e08-old");
    const mainHandle = mainEx.stream({}, "step-e08-main", [LOOKUP_TOOL]);
    const mainConsume = consumer.consume("step-e08-main", mainHandle);
    await Promise.all([mainConsume, mainHandle.response]);
    releaseOld();
    await Promise.all([oldConsume, oldHandle.response]);
    expect(consumer.live("tool").map((row) => row.id)).toEqual(["call-step-e08-main"]);
    expect(consumer.live("delivery").map((row) => row.id)).toEqual(["step-e08-main:delivery"]);
    expect(consumer.effects).toContainEqual({
      kind: "tool", stepId: "step-e08-old", id: "call-step-e08-old", late: true,
    });
    expect(consumer.live("tool")).not.toContainEqual(expect.objectContaining({ stepId: "step-e08-old" }));
    expect(mainEx.getState()).toEqual(mainWindow);
    expect(oldEx.getState()).toEqual(oldWindow);
  });

  test("E08 publish-before fault keeps prior root; mirror fault does not roll back", async () => {
    const selected = windowRows();
    const next = [...selected, { role: "user" as const, content: "committed-after-success" }];
    await withFakeHttpSession({
      turnId: "HOST_TURN_E08_fault",
      fn: async ({ session, dir }) => {
        const store = join(dir, "host-window-root.json");
        const prior = await publishHostRoot(store, selected as unknown[]);
        await session.getExecutor(selected).stream({}, "step-e08-fault", [LOOKUP_TOOL]).response;
        await expect(publishHostRoot(store, next as unknown[], undefined, "before-publish")).rejects.toMatchObject({
          name: "OwnedRootFault",
          kind: "before-publish",
        });
        expect((await readHostRoot(store)).refs.sha256).toBe(prior.refs.sha256);
        const reopenPrior = await runWorker("reopen-state", store);
        expect(reopenPrior.state).toEqual(selected);
        try {
          await publishHostRoot(store, next as unknown[], undefined, "mirror");
          throw new Error("expected mirror fault");
        } catch (error) {
          expect(error).toMatchObject({ name: "OwnedRootFault", kind: "mirror" });
        }
        const committed = await readHostRoot(store);
        expect(committed.refs.sha256).not.toBe(prior.refs.sha256);
        expect(committed.state).toEqual(next);
        const reopenCommitted = await runWorker("reopen-state", store);
        expect(reopenCommitted.diskSha).toBe(committed.refs.sha256);
        expect(reopenCommitted.state).toEqual(next);
        expect(reopenCommitted.pid).not.toBe(process.pid);
      },
    });
  }, 30_000);
});

describe("E07 auxiliary after main STEP", () => {
  test("E07 Path B same-session aux uses captured selection; wrong-model 0 extra dispatch", async () => {
    await withFakeHttpSession({
      turnId: "HOST_TURN_E07_main",
      fn: async ({ session, requests }) => {
        const mainWindow = windowRows();
        const mainEx = session.getExecutor(mainWindow);
        const parent = {
          agentId: "agent-tom",
          turnId: "HOST_TURN_E07_main",
          stepId: "step-e07-main",
          modelId: SYNTHETIC_OPENAI.id,
          selectionRevision: computeSelectionRevision({ agentId: "agent-tom", model: SYNTHETIC_OPENAI }),
        };
        const seen = new Set<string>();
        const memory = createHostMemoryControl();
        memory.commit(await runAuxiliary({
          session, purpose: "memory-extraction", auxRequestId: "aux-early", parentLive: true, parent, seen,
          messages: [{ role: "user", content: "extract" }],
        }));
        expect(requests).toHaveLength(0);
        await mainEx.stream({}, "step-e07-main", [LOOKUP_TOOL]).response;
        expect(requests).toHaveLength(1);
        expect(requests[0]!.text).toContain("gpt-4o-mini");
        const before = mainEx.getState();
        memory.commit(await runAuxiliary({
          session, purpose: "memory-extraction", auxRequestId: "aux-e07", parentLive: true, parent, seen,
          messages: [{ role: "user", content: "purpose: episode" }],
        }));
        expect(requests).toHaveLength(2);
        expect(requests[1]!.text).toContain("gpt-4o-mini");
        expect(requests[1]!.text).not.toContain("unrelated-model");
        expect(memory.memories).toEqual([{ purpose: "memory-extraction", auxRequestId: "aux-e07", text: "ok" }]);
        expect(mainEx.getState()).toEqual(before);
        const wrong = await runAuxiliary({
          session, purpose: "memory-extraction", auxRequestId: "aux-wrong-model", parentLive: true,
          parent: { ...parent, modelId: "other/unrelated-model" }, seen,
          messages: [{ role: "user", content: "extract" }],
        });
        expect(wrong).toMatchObject({ kind: "refused", code: "auxiliary_unqualified" });
        expect(requests).toHaveLength(2);
        memory.commit(await runAuxiliary({
          session, purpose: "memory-extraction", auxRequestId: "aux-tools", parentLive: true, parent, seen,
          tools: [LOOKUP_TOOL], messages: [{ role: "user", content: "extract" }],
        }));
        expect(requests).toHaveLength(2);
      },
    });
  }, 20_000);
});
