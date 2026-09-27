import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { ROUTE_SESSION_SYMBOL } from "../src/internal/host/profile.ts";
import { emitLiteralSlicePair } from "../src/internal/ops/host-seam/slice-emit.ts";
import { structuralShapeSync } from "../src/internal/ops/host-seam/shape.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";
import type { ShapeCandidate } from "../src/internal/ops/host-seam/shape-worker.ts";

function unique(source: string, sliceId: ShapeCandidate["sliceId"]): ShapeCandidate {
  const rows = structuralShapeSync(source).candidates.filter((row) => row.sliceId === sliceId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function transformedTwoSlice() {
  const emitted = emitLiteralSlicePair({
    source: LIVE_SHAPED_HOST,
    create: unique(LIVE_SHAPED_HOST, "create-session"),
    agent: unique(LIVE_SHAPED_HOST, "agent-id"),
    turnName: "inferenceRequestId",
  });
  expect(emitted.status).toBe("ok");
  if (emitted.status !== "ok") throw new Error("emit");
  expect(emitted.slices.map((slice) => slice.id)).toEqual(["create-session", "agent-id"]);
  expect(emitted.writes).toBe(0);
  expect(emitted.hostSignals).toBe(0);
  return emitted.replay.source;
}

function runPatched(input: {
  source: string;
  hook?: (args: { agentId?: string; sessionOptions?: { invocationId?: string; agentId?: string } }) => unknown;
  throwFactory?: boolean;
}) {
  const official = { getModelId: () => "official" };
  const counts = { factory: 0, extraTools: 0, extraAgents: 0 };
  const context = {
    module: { exports: {} as { api: unknown; runTurn: (host: unknown) => Promise<unknown> } },
    createCursorInferencePromptSession: () => {
      counts.factory += 1;
      if (input.throwFactory) throw Error("official factory unavailable");
      return official;
    },
    [Symbol.for(ROUTE_SESSION_SYMBOL)]: input.hook,
  };
  runInNewContext(input.source, context);
  return {
    official,
    counts,
    run: (agentId: string) => context.module.exports.runTurn({
      getConversationId: () => agentId,
      subagentModelId: "official",
      inference: context.module.exports.api,
    }),
  };
}

describe("HSO-4 synthetic two-slice Host behavior", () => {
  test("emission preserves method directive semantics before selecting a session", async () => {
    const source = LIVE_SHAPED_HOST.replace('"use strict";', "")
      .replace("createSession(onRequestId, sessionOptions) {", 'createSession(onRequestId, sessionOptions) {\n      "use strict";')
      .replace("const inferenceOptions = { sessionOptions, onRequestId };",
        "const inferenceOptions = { strict: (function () { return this === undefined; })() };");
    const emitted = emitLiteralSlicePair({ source, create: unique(source, "create-session"),
      agent: unique(source, "agent-id"), turnName: "inferenceRequestId" });
    if (emitted.status !== "ok") throw Error(emitted.status);
    const context = { module: { exports: {} as { api: unknown; runTurn: (host: unknown) => Promise<boolean> } },
      createCursorInferencePromptSession: (options: { strict: boolean }) => options.strict };
    runInNewContext(emitted.replay.source, context);
    expect(await context.module.exports.runTurn({ getConversationId: () => "official", subagentModelId: "official",
      inference: context.module.exports.api })).toBe(true);
  });
  test("decline keeps the official session; Agent/TURN reach the hook; no extra loops", async () => {
    const source = transformedTwoSlice();
    const entries: unknown[] = [];
    const declined = runPatched({
      source,
      hook: (args) => {
        entries.push(args);
        return undefined;
      },
    });
    expect(await declined.run("canary")).toBe(declined.official);
    expect(declined.counts).toEqual({ factory: 1, extraTools: 0, extraAgents: 0 });
    expect(entries).toMatchObject([{
      agentId: "canary",
      sessionOptions: { invocationId: "inv-live-shaped", agentId: "canary" },
    }]);

    const managed = { getModelId: () => "managed" };
    const taken: unknown[] = [];
    const overlay = runPatched({
      source,
      hook: (args) => {
        taken.push(args);
        return managed;
      },
    });
    expect(await overlay.run("canary")).toBe(managed);
    expect(overlay.counts.factory).toBe(0);
    expect(taken).toMatchObject([{ agentId: "canary", sessionOptions: { invocationId: "inv-live-shaped" } }]);
  });

  test("managed selection precedes an unavailable official factory; decline still observes its failure", async () => {
    const source = transformedTwoSlice();
    let hooked = 0;
    const f = runPatched({
      source,
      throwFactory: true,
      hook: () => {
        hooked += 1;
        return { getModelId: () => "managed" };
      },
    });
    expect(await f.run("canary")).toMatchObject({ getModelId: expect.any(Function) });
    expect(hooked).toBe(1);
    expect(f.counts.factory).toBe(0);
    const declined = runPatched({ source, throwFactory: true, hook: () => undefined });
    await expect(declined.run("official")).rejects.toThrow("official factory unavailable");
    expect(declined.counts.factory).toBe(1);
    const rejected = runPatched({ source, hook: () => { throw Error("managed selection unavailable"); } });
    await expect(rejected.run("canary")).rejects.toThrow("managed selection unavailable");
    expect(rejected.counts.factory).toBe(0);
  });
});
