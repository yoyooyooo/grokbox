import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { applyPatchProfile, profileFromSource, ROUTE_SESSION_SYMBOL } from "../src/internal/host/profile.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

function fixture(hook: ((args: { agentId?: string; sessionOptions?: { invocationId?: string } }) => unknown) | undefined) {
  // The native provider may resolve its own model/client before constructing an official session.
  // A managed assignment must not depend on those unrelated provider preconditions.
  const source = LIVE_SHAPED_HOST.replace(
    "const inferenceOptions = { sessionOptions, onRequestId };",
    "const inferenceOptions = prepareOfficialOptions(sessionOptions, onRequestId);",
  );
  const profile = profileFromSource(source, LIVE_SLICE_PATCHES, "entry-fixture");
  const transformed = applyPatchProfile(source, profile);
  if (!transformed.ok) throw Error(transformed.code);
  const counts = { prepare: 0, factory: 0 };
  const official = { getModelId: () => "official" };
  let failOfficial = false;
  const context = {
    module: { exports: {} as { api: unknown; runTurn: (host: unknown) => Promise<unknown> } },
    prepareOfficialOptions: () => {
      counts.prepare += 1;
      if (failOfficial) throw Error("official provider unavailable");
      return {};
    },
    createCursorInferencePromptSession: () => { counts.factory += 1; return official; },
    [Symbol.for(ROUTE_SESSION_SYMBOL)]: hook,
  };
  runInNewContext(transformed.source, context);
  return {
    counts,
    official,
    failOfficial: () => { failOfficial = true; },
    run: (agentId: string) => context.module.exports.runTurn({
      getConversationId: () => agentId,
      subagentModelId: "official",
      inference: context.module.exports.api,
    }),
  };
}

describe("Host entry interception", () => {
  test("managed routing precedes official model resolution and factory creation", async () => {
    const managed = { getModelId: () => "managed" };
    const entries: unknown[] = [];
    const f = fixture((args) => { entries.push(args); return managed; });
    f.failOfficial();
    expect(await f.run("canary")).toBe(managed);
    expect(f.counts).toEqual({ prepare: 0, factory: 0 });
    expect(entries).toMatchObject([{ agentId: "canary", sessionOptions: { invocationId: "inv-live-shaped" } }]);
  });

  test("declining and absent hooks preserve the exact official session", async () => {
    for (const hook of [undefined, () => undefined]) {
      const f = fixture(hook);
      expect(await f.run("unassigned")).toBe(f.official);
      expect(f.counts).toEqual({ prepare: 1, factory: 1 });
    }
  });

  test("an entered hook failure does not silently construct an official fallback", async () => {
    const f = fixture(() => { throw Error("controlled hook failure"); });
    await expect(f.run("canary")).rejects.toThrow("controlled hook failure");
    expect(f.counts).toEqual({ prepare: 0, factory: 0 });
  });
});
