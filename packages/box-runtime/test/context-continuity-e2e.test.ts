import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectStreamParts } from "./host-consumer.ts";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { computeSelectionRevision, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import {
  ARCHIVED_ONLY,
  assertIndependentGoldenInHttp,
  assertNoCapStoreOrDecoy,
  compactJourneyWindow,
  END_SENTINEL,
  FACT_ALPHA,
  HOST_P_USED,
  HOST_S_USED,
  hostAcceptSummary,
  hostObserveExtendedUsage,
  longZeroCapWindow,
  LOOKUP_TOOL,
  metadataWindow,
  PAD_BODY,
  sha256Json,
  SYNTHETIC_OPENAI,
  SYNTHETIC_OPENAI_NO_WINDOW,
  SYNTHETIC_W,
  TOOL_BODY,
  UI_DECOY,
  UNICODE_SENTINEL,
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
    const cacheWrite = 3;
    let rootCommitted = false;
    await withFakeHttpSession({
      turnId: `HOST_TURN_E05_${used}_${phase}`,
      usage: {
        prompt_tokens: used - output,
        completion_tokens: output,
        total_tokens: used,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
      },
      fn: async ({ session, requests }) => {
        const executor = session.getExecutor(windowRows());
        const handle = executor.stream({}, `step-e05-${used}-${phase}`, [LOOKUP_TOOL]);
        const extended = await handle.extendedUsage;
        expect(extended.maxTokens).toBe(SYNTHETIC_W);
        expect(extended.maxTokens).not.toBe(0);
        expect(extended.maxTokens).not.toBe(extended.outputTokens);
        expect(extended.inputTokens).toBe(used - output);
        expect(extended.outputTokens).toBe(output);
        expect(extended.cacheReadTokens).toBe(cacheRead);
        expect(extended.cacheWriteTokens).not.toBe(extended.inputTokens);
        const body = requests[0]?.body as { max_tokens?: unknown } | undefined;
        if (typeof body?.max_tokens === "number") expect(extended.maxTokens).not.toBe(body.max_tokens);
        const observed = hostObserveExtendedUsage(extended, phase);
        expect(observed.W).toBe(SYNTHETIC_W);
        expect(observed.U).toBe(used);
        expect(observed.started).toBe(used >= HOST_S_USED);
        expect(observed.persist).toBe(used >= HOST_P_USED);
        if (phase === "mid-loop") expect(observed.accepted).toBe(observed.started);
        else expect(observed.accepted).toBe(observed.persist);
        expect(rootCommitted).toBe(false);
        if (phase === "turn-tail" && observed.accepted) rootCommitted = true;
        expect(rootCommitted).toBe(phase === "turn-tail" && observed.accepted);
        expect(executor.getState()).toEqual(windowRows());
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
        version: 1,
        models: { [SYNTHETIC_OPENAI.id]: { ...SYNTHETIC_OPENAI, contextWindowTokens } },
        assignments: { main: null, agents: { "agent-tom": SYNTHETIC_OPENAI.id } },
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
    await withFakeHttpSession({
      turnId: "HOST_TURN_E06_live",
      hold,
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      fn: async ({ session, makeSession, requests }) => {
        const live = session.getExecutor(windowRows());
        const pending = live.stream({}, "step-e06-live", [LOOKUP_TOOL]);
        makeSession({ turnId: "HOST_TURN_E06_next", model: narrow, contextWindowTokens: 32000 });
        expect(computeSelectionRevision({ agentId: "agent-tom", model: SYNTHETIC_OPENAI }))
          .not.toBe(computeSelectionRevision({ agentId: "agent-tom", model: narrow }));
        release();
        const liveUsage = await pending.extendedUsage;
        expect(liveUsage.maxTokens).toBe(SYNTHETIC_W);
        expect(live.getState()).toEqual(windowRows());
        expect(requests).toHaveLength(1);
      },
    });
  }, 20_000);
});
