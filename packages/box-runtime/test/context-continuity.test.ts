import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import { BoxRuntimeError, ENCODED_PROVIDER_REQUEST_MAX_BYTES, contextSnapshotBody } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { testSdkBackendLayer } from "../src/internal/roots/layers.ts";
import {
  asHostPromptSession,
  createStreamingPromptSession,
  InvalidHostStateError,
  type StreamPart,
} from "./packed-host-session.ts";
import { admitAuxiliary, runAuxiliary } from "../src/internal/host/auxiliary.ts";
import { captureHostManagedSelection } from "../src/internal/host/selection.node.ts";
import {
  createHostMemoryControl,
  createHostOutputConsumer,
  HOST_P_USED,
  HOST_S_USED,
  hostObserveExtendedUsage,
  LOOKUP_TOOL,
  metadataWindow,
  mulberry32,
  readHostRoot,
  SYNTHETIC_OPENAI,
  SYNTHETIC_W,
  writeHostRoot,
  writeUiDecoy,
} from "./context-continuity-fixture.ts";

const WORKER = fileURLToPath(new URL("./context-continuity-reload-worker.ts", import.meta.url));
const FINISH: StreamPart = { type: "finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };

function session() {
  let calls = 0;
  const requests: Array<{ messages: unknown }> = [];
  return {
    calls: () => calls,
    requests,
    session: asHostPromptSession(createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "allow",
      providerCalls: { get count() { return calls; }, set count(value) { calls = value; } },
      produce: (request) => {
        requests.push({ messages: request.envelope.messages });
        return (async function* () {
          yield { type: "text-delta" as const, textDelta: "ok" };
          yield FINISH;
        })();
      },
    }), "stub/echo"),
  };
}

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

describe("E01 factory + state law", () => {
  test("E01 factory + state law: executors are isolated and keep Host metadata", async () => {
    const { session: host, requests } = session();
    const window = metadataWindow();
    const main = host.getExecutor(window);
    const empty = host.getExecutor();
    const untracked = host.getExecutorWithoutResolvedModelTracking(window);
    expect(main).not.toBe(empty);
    expect(main).not.toBe(untracked);
    expect(untracked).not.toBe(host.getExecutorWithoutResolvedModelTracking(window));
    expect(empty.getState()).toEqual([]);
    empty.appendMessages([{ role: "user", content: "aux-only" }]);
    expect(main.getState()).toEqual(window);
    const copy = main.getMessages() as Array<{ content: unknown }>;
    copy[0]!.content = "mutated-copy";
    copy.push({ content: "alias" });
    expect(main.getState()).toEqual(window);
    const other = host.getExecutor([{ role: "user", content: "other-start" }]);
    other.appendMessages([{ role: "assistant", content: "other-more" }]);
    other.clearMessages();
    other.appendMessages([{ role: "user", content: "other-rebuilt" }]);
    expect(main.getState()).toEqual(window);
    expect(JSON.stringify(main.getState())).toContain("userInfoSummarizationEpoch");
    expect(JSON.stringify(main.getState())).toContain("sys-1");
    await main.stream({}, "step-meta").response;
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("sys-1");
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("userInfoSummarizationEpoch");
    expect(main.getState()).toEqual(window);
  });

  test("E01 factory + state law: legal operation sequences stay isolated", () => {
    const window = metadataWindow();
    for (let seed = 1; seed <= 16; seed += 1) {
      const rand = mulberry32(seed);
      const { session: host } = session();
      const keep = host.getExecutor(window);
      const actor = host.getExecutor([{ role: "user", content: `seed-${seed}` }]);
      const ops = 4 + Math.floor(rand() * 6);
      for (let i = 0; i < ops; i += 1) {
        const roll = rand();
        if (roll < 0.25) actor.appendMessages([{ role: "user", content: `n-${seed}-${i}` }]);
        else if (roll < 0.4) actor.clearMessages();
        else if (roll < 0.7) {
          const copy = actor.getMessages() as unknown[];
          copy.push({ role: "user", content: "copy-only" });
        } else {
          const sibling = host.getExecutor([{ role: "user", content: `sib-${seed}-${i}` }]);
          sibling.appendMessages([{ role: "assistant", content: "sib-more" }]);
        }
      }
      expect(keep.getState()).toEqual(window);
      const again = host.getExecutor(window);
      expect(again).not.toBe(keep);
      expect(again.getState()).toEqual(window);
    }
  });
});

describe("E02 invalid state → checkpoint", () => {
  test("E02 invalid state is not a checkpointable success", async () => {
    const { session: host, calls } = session();
    const legal = metadataWindow();
    const keep = host.getExecutor(legal);
    const dir = await mkdtemp(join(tmpdir(), "grokbox-ctx-e02-"));
    const store = join(dir, "host-window-root.json");
    const first = await writeHostRoot(store, keep.getState() as unknown[]);
    const before = await readFile(store);
    const beforeStat = await stat(store);

    const badBind = host.getExecutor({
      messages: [
        { role: "user", content: "keep-me" },
        { role: "user", content: [{ type: "file", url: "private-file" }] },
      ],
    });
    expect(() => badBind.getState()).toThrow(InvalidHostStateError);
    expect(() => JSON.stringify(badBind.getState())).toThrow();

    const atomic = host.getExecutor([{ role: "user", content: "legal-start" }]);
    atomic.appendMessages([
      { role: "assistant", content: "legal-mid" },
      { role: "user", content: [{ type: "file", url: "private-tail" }] },
    ]);
    expect(() => atomic.getState()).toThrow(InvalidHostStateError);
    atomic.appendMessages([{ role: "user", content: "ignored-while-invalid" }]);
    expect(() => atomic.getState()).toThrow(InvalidHostStateError);

    let reads = 0;
    const hot = host.getExecutor([{
      role: "user",
      get content() { reads += 1; return "private-getter"; },
    }]);
    expect(reads).toBe(0);
    expect(() => hot.getState()).toThrow(/unsupported_content/);
    await expect(hot.stream({}, "step-invalid").response).rejects.toMatchObject({ name: "RetriableError" });
    expect(reads).toBe(0);
    expect(calls()).toBe(0);

    const cleared = host.getExecutor([{ role: "user", content: "before-clear" }]);
    cleared.clearMessages();
    cleared.appendMessages([{ role: "system", content: "new-system" }]);
    cleared.appendMessages([{ role: "user", content: [{ type: "file", url: "after-system" }] }]);
    expect(() => cleared.getState()).toThrow(InvalidHostStateError);

    expect(() => badBind.getState()).toThrow();
    expect(Buffer.from(await readFile(store)).equals(before)).toBe(true);
    expect((await stat(store)).size).toBe(beforeStat.size);
    expect(keep.getState()).toEqual(legal);
    expect((await readHostRoot(store)).refs.sha256).toBe(first.refs.sha256);
  });

  test("E02 invalid checkpoint leaves previous root bytes unchanged across reopen", async () => {
    const { session: host } = session();
    const legal = metadataWindow();
    const executor = host.getExecutor(legal);
    const dir = await mkdtemp(join(tmpdir(), "grokbox-ctx-e02r-"));
    const store = join(dir, "host-window-root.json");
    await writeHostRoot(store, executor.getState() as unknown[]);
    await writeUiDecoy(dir);
    const before = await readFile(store);
    executor.appendMessages([{ role: "user", content: [{ type: "file", url: "private-tail" }] }]);
    expect(() => executor.getState()).toThrow(InvalidHostStateError);
    const after = await readFile(store);
    expect(after.equals(before)).toBe(true);
    const reopened = await runWorker("reopen-state", store);
    expect(reopened.ok).toBe(true);
    expect(reopened.diskSha).toBe((await readHostRoot(store)).refs.sha256);
    expect(reopened.state).toEqual(legal);
    expect(reopened.pid).not.toBe(process.pid);
    expect(reopened.decoyPresent).toBe(false);
  });
});

describe("E05 Host S/P oracle vs W mutants", () => {
  test("E05 zero-W and output-cap mutants never start or persist", () => {
    const honest = hostObserveExtendedUsage({
      inputTokens: HOST_P_USED - 20, outputTokens: 20, cacheReadTokens: 1, cacheWriteTokens: 2, maxTokens: SYNTHETIC_W,
    }, "turn-tail");
    expect(honest.W).toBe(SYNTHETIC_W);
    expect(honest.started).toBe(true);
    expect(honest.persist).toBe(true);
    const zeroW = hostObserveExtendedUsage({
      inputTokens: HOST_P_USED, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0,
    }, "turn-tail");
    expect(zeroW.started).toBe(false);
    expect(zeroW.persist).toBe(false);
    expect(zeroW.eligible).toBe(false);
    const outputCap = hostObserveExtendedUsage({
      inputTokens: HOST_S_USED, outputTokens: 4096, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 4096,
    }, "mid-loop");
    expect(outputCap.W).not.toBe(SYNTHETIC_W);
    expect(outputCap.W).toBe(4096);
  });
});

describe("E06 window parse fail-closed", () => {
  test("E06 unknown 0/neg/non-int windows are not qualified models", () => {
    for (const contextWindowTokens of [0, -8, 3.14]) {
      expect(() => parseModelsFile({
        version: 1,
        models: { [SYNTHETIC_OPENAI.id]: { ...SYNTHETIC_OPENAI, contextWindowTokens } },
        assignments: { main: null, agents: { "agent-tom": SYNTHETIC_OPENAI.id } },
      })).toThrow(BoxRuntimeError);
    }
  });
});

describe("E08 encoded-request gate", () => {
  test("E08 encoded provider request over 8MiB fails before fetch", async () => {
    let http = 0;
    const fetchImpl = Object.assign(async () => {
      http += 1;
      return new Response("nope");
    }, { preconnect: async () => undefined }) as typeof fetch;
    const body = contextSnapshotBody({
      version: 1,
      profileId: "t21-independent-root",
      abiIdentity: "host-abi-v1",
      systemMessages: [{ role: "system", content: "root" }],
      messages: [{ role: "user", content: "tiny" }],
      tools: [],
      options: {},
    });
    const snap = { ...body, snapshotDigest: computeSnapshotDigest(body) };
    const longModel = "m".repeat(ENCODED_PROVIDER_REQUEST_MAX_BYTES);
    await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* BackendAuth;
      const backend = yield* ModelBackend;
      const pinned = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
      const prepared = yield* backend.prepare({
        id: "openai/gpt-4o-mini",
        provider: "openai",
        model: longModel,
        endpoint: "https://ccs.test/v1",
        apiKeyRef: "env:OPENAI_API_KEY",
        capabilities: { vision: false, tools: true, images: false },
        dataTypes: ["text", "tools"],
        contextWindowTokens: 200000,
      }, snap);
      return yield* Stream.runCollect(backend.infer({}, prepared, pinned.lease));
    }).pipe(Effect.provide(testSdkBackendLayer({ fetch: fetchImpl, env: { OPENAI_API_KEY: "sk-test" } })))))).rejects.toMatchObject({ code: "envelope_too_large" });
    expect(http).toBe(0);
  });

  test("E08 consumer records no delivery on zero-output or post-tool stream failure", async () => {
    const failNow = createHostOutputConsumer();
    const zero = asHostPromptSession(createStreamingPromptSession({
      modelId: SYNTHETIC_OPENAI.id, vision: false, parallel: "allow",
      produce: async function* () { throw new Error("zero-output"); },
    }), SYNTHETIC_OPENAI.id, undefined, { contextWindowTokens: 200000 });
    await expect(failNow.consume("step-zero", zero.getExecutor([{ role: "user", content: "z" }]).stream({}, "step-zero"))).rejects.toBeDefined();
    expect(failNow.live("delivery")).toEqual([]);
    expect(failNow.live("tool")).toEqual([]);
    expect(failNow.effects.some((row) => row.kind === "error" && row.stepId === "step-zero")).toBe(true);

    const afterTool = createHostOutputConsumer();
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: SYNTHETIC_OPENAI.id, vision: false, parallel: "allow",
      produce: async function* () {
        yield { type: "tool-call", toolCallId: "call-then-fail", toolName: "lookup", args: { q: "x" } };
        yield { type: "error", error: { userVisible: true as const, code: "model_error", message: "after-tool" } };
      },
    }), SYNTHETIC_OPENAI.id, undefined, { contextWindowTokens: 200000 });
    await expect(afterTool.consume("step-tool", session.getExecutor([{ role: "user", content: "t" }]).stream({}, "step-tool", [LOOKUP_TOOL]))).rejects.toBeDefined();
    expect(afterTool.live("tool").map((row) => row.id)).toEqual(["call-then-fail"]);
    expect(afterTool.live("delivery")).toEqual([]);
  });
});

describe("E07 auxiliary purpose fence", () => {
  function auxHarness(mode: "ok" | "half" = "ok") {
    const counts = { aux: 0 };
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: SYNTHETIC_OPENAI.id,
      vision: false,
      parallel: "allow",
      produce: async function* () {
        counts.aux += 1;
        yield { type: "text-delta" as const, textDelta: "FACT-FROM-AUX" };
        if (mode === "half") throw new Error("half-stream");
        yield FINISH;
      },
    }), SYNTHETIC_OPENAI.id, undefined, { requireStepId: false, contextWindowTokens: SYNTHETIC_W });
    return { counts, session };
  }

  test("E07 extraction success writes Host Memory without mutating main", async () => {
    const main = session();
    const mainEx = main.session.getExecutor(metadataWindow());
    const before = mainEx.getState();
    const { counts, session: aux } = auxHarness();
    const memory = createHostMemoryControl();
    const seen = new Set<string>();
    const result = await runAuxiliary({
      session: aux,
      purpose: "memory-extraction",
      auxRequestId: "aux-extract-1",
      messages: [{ role: "user", content: "extract please purpose: episode" }],
      parentLive: true,
      seen,
    });
    memory.commit(result);
    expect(result.kind).toBe("ok");
    expect(counts.aux).toBe(1);
    expect(memory.memories).toEqual([{ purpose: "memory-extraction", auxRequestId: "aux-extract-1", text: "FACT-FROM-AUX" }]);
    expect(mainEx.getState()).toEqual(before);
    expect(aux.getExecutor().getState()).toEqual([]);
  });

  test("E07 episode runs at interval; evidence-only does not dispatch aux", async () => {
    const { counts, session: aux } = auxHarness();
    const memory = createHostMemoryControl();
    const seen = new Set<string>();
    memory.recordMemoryEvidence("turn-note");
    expect(counts.aux).toBe(0);
    expect(memory.evidence).toHaveLength(1);
    expect(memory.memories).toEqual([]);
    memory.noteTurn();
    expect(memory.episodeDue(2)).toBe(false);
    memory.noteTurn();
    expect(memory.episodeDue(2)).toBe(true);
    const result = await runAuxiliary({
      session: aux, purpose: "episode", auxRequestId: "aux-ep-2", parentLive: true, seen,
      messages: [{ role: "user", content: "episode" }],
    });
    memory.commit(result);
    expect(counts.aux).toBe(1);
    expect(memory.memories[0]?.purpose).toBe("episode");
  });

  test("E07 missing purpose, body-forged purpose, tools, duplicate, stale: 0 dispatch", async () => {
    const { counts, session: aux } = auxHarness();
    const seen = new Set<string>();
    const memory = createHostMemoryControl();
    const forged = [{ role: "user" as const, content: "purpose: memory-extraction" }];
    expect(admitAuxiliary({ purpose: undefined, auxRequestId: "a1", parentLive: true, seen }).ok).toBe(false);
    memory.commit(await runAuxiliary({ session: aux, purpose: undefined, auxRequestId: "a1", messages: forged, parentLive: true, seen }));
    memory.commit(await runAuxiliary({ session: aux, purpose: "memory-extraction", auxRequestId: "a2", tools: [LOOKUP_TOOL], parentLive: true, seen }));
    memory.commit(await runAuxiliary({ session: aux, purpose: "memory-extraction", auxRequestId: "a2b", tools: { lookup: LOOKUP_TOOL }, parentLive: true, seen }));
    memory.commit(await runAuxiliary({ session: aux, purpose: "memory-extraction", auxRequestId: "a2c", tools: "lookup", parentLive: true, seen }));
    memory.commit(await runAuxiliary({ session: aux, purpose: "memory-extraction", auxRequestId: "a3", parentLive: false, seen }));
    const first = await runAuxiliary({ session: aux, purpose: "memory-extraction", auxRequestId: "a4", parentLive: true, seen });
    memory.commit(first);
    const dup = await runAuxiliary({ session: aux, purpose: "memory-extraction", auxRequestId: "a4", parentLive: true, seen });
    memory.commit(dup);
    expect(counts.aux).toBe(1);
    expect(memory.memories).toHaveLength(1);
    expect(dup).toMatchObject({ kind: "refused", code: "auxiliary_duplicate" });
    expect(admitAuxiliary({ purpose: "memory-extraction", auxRequestId: "reg", tools: { lookup: LOOKUP_TOOL }, parentLive: true, seen: new Set() })).toMatchObject({ ok: false, code: "auxiliary_tools" });
  });

  test("E07 abort and parent expiry after await do not commit Memory", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let live = true;
    const counts = { aux: 0 };
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: SYNTHETIC_OPENAI.id, vision: false, parallel: "allow",
      produce: async function* () {
        counts.aux += 1;
        yield { type: "text-delta" as const, textDelta: "PARTIAL-AUX" };
        await hold;
        yield FINISH;
      },
    }), SYNTHETIC_OPENAI.id, undefined, { requireStepId: false, contextWindowTokens: SYNTHETIC_W });
    const ac = new AbortController();
    const abortRun = runAuxiliary({
      session, purpose: "memory-extraction", auxRequestId: "aux-abort", parentLive: () => live, seen: new Set(),
      abortSignal: ac.signal, messages: [{ role: "user", content: "x" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    ac.abort();
    release();
    const abortResult = await abortRun;
    expect(abortResult.kind).not.toBe("ok");
    expect(counts.aux).toBe(1);

    live = true;
    const staleHold = new Promise<void>((resolve) => { release = resolve; });
    const staleSession = asHostPromptSession(createStreamingPromptSession({
      modelId: SYNTHETIC_OPENAI.id, vision: false, parallel: "allow",
      produce: async function* () {
        counts.aux += 1;
        yield { type: "text-delta" as const, textDelta: "FULL-AUX" };
        await staleHold;
        yield FINISH;
      },
    }), SYNTHETIC_OPENAI.id, undefined, { requireStepId: false, contextWindowTokens: SYNTHETIC_W });
    const staleRun = runAuxiliary({
      session: staleSession, purpose: "memory-extraction", auxRequestId: "aux-stale-late", parentLive: () => live, seen: new Set(),
      messages: [{ role: "user", content: "x" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    live = false;
    release();
    const staleResult = await staleRun;
    expect(staleResult).toMatchObject({ kind: "failed", code: "auxiliary_stale" });
  });

  test("E07 half-stream failure does not write error text as Memory", async () => {
    const { counts, session: aux } = auxHarness("half");
    const memory = createHostMemoryControl();
    const result = await runAuxiliary({
      session: aux, purpose: "memory-extraction", auxRequestId: "aux-half", parentLive: true, seen: new Set(),
      messages: [{ role: "user", content: "extract" }],
    });
    memory.commit(result);
    expect(result.kind).toBe("failed");
    expect(counts.aux).toBe(1);
    expect(memory.memories).toEqual([]);
  });

  test("E07 main missing STEP is 0 dispatch; self-summary with STEP runs", async () => {
    const counts = { main: 0 };
    const host = asHostPromptSession(createStreamingPromptSession({
      modelId: SYNTHETIC_OPENAI.id, vision: false, parallel: "allow",
      produce: async function* () {
        counts.main += 1;
        yield { type: "text-delta" as const, textDelta: "self" };
        yield FINISH;
      },
    }), SYNTHETIC_OPENAI.id, undefined, { requireStepId: true, contextWindowTokens: SYNTHETIC_W });
    const ex = host.getExecutor([{ role: "user", content: "main" }]);
    await expect(ex.stream({}, undefined).response).rejects.toBeDefined();
    expect(counts.main).toBe(0);
    await ex.stream({}, "step-self-summary").response;
    expect(counts.main).toBe(1);
  });

  test("E07 dedicated external without agent stays official", () => {
    expect(captureHostManagedSelection("/tmp/does-not-exist-models", undefined).kind).toBe("official");
  });
});
