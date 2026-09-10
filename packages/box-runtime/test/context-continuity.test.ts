import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvelopeError } from "@grokbox/runtime-kernel/contract";
import {
  asHostPromptSession,
  createStreamingPromptSession,
  InvalidHostStateError,
  type StreamPart,
} from "../src/internal/host/session.ts";
import {
  metadataWindow,
  mulberry32,
  readHostRoot,
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
    expect(() => hot.getState()).toThrow(EnvelopeError);
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
