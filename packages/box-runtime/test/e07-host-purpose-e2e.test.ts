import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { wrapHostAuxExecutor } from "../src/internal/host/aux-purpose.ts";
import { grokboxAuxFrom } from "../src/internal/host/aux-request.ts";
import { withFakeHttpSession, SYNTHETIC_OPENAI, TEST_BINDING, HEX, sseChatOk } from "./context-continuity-fixture.ts";
import { E07_STEP, E07_TURN, loadE07Host, writeE07Models, auxiliaryEvents, type E07Memory } from "./e07-host-fixture.ts";

async function fixture(dir: string) {
  await writeE07Models(dir);
  const host = loadE07Host({ hook: bindHostSessionHook({ mode: "route", durableRoot: dir, runRoot: dir, binding: TEST_BINDING,
    compile: { profileId: "e07-shaped", profileSha256: HEX("e"), sourceSha256: HEX("b"), transformedSha256: HEX("d") },
  }) });
  const session = await host.fixtureSession();
  const ctx = host.fixtureContext();
  const main = session.getExecutor([{ role: "system", content: "owned-main-root" }]);
  main.appendMessages([{ role: "user", content: "main-window-not-aux" }]);
  const memories: E07Memory[] = [];
  const store = { addMemory: (row: E07Memory) => { memories.push(row); } };
  const memory = (pending: unknown[] = [], context = ctx) => host.runTurnMemory(store, pending, session, context, 1, { user: "purpose: episode (body decoy)", agent: "completed" });
  return { host, session, ctx, main, memories, memory };
}
describe("E07 exact Host purpose through usage wrapper / real hook / Unix / SDK Fake HTTP", () => {
  test("E07 Host memory and interval episode use the actual parent STEP and captured selection", async () => {
    await withFakeHttpSession({ turnId: E07_TURN, fn: async ({ dir, requests }) => {
      const f = await fixture(dir);
      await f.main.appendMessages([{ role: "user", content: "append-chain" }]).stream(f.ctx, E07_STEP).response;
      const before = f.main.getState();
      // Unrelated factories and a changed disk selection are not purpose/parent sources.
      for (let i = 0; i < 5; i++) f.session.getExecutor().clearMessages();
      await writeFile(join(dir, "models.json"), "invalid-new-selection");
      await f.memory(["first", "second"]);
      expect(f.memories).toEqual([{ purpose: "memory-extraction", text: "ok" }, { purpose: "episode", text: "ok" }]);
      expect(f.main.getState()).toEqual(before);
      expect(grokboxAuxFrom(f.ctx)).toBeUndefined();
      expect(f.host.fixtureOfficial).toHaveLength(0);
      expect(requests).toHaveLength(3);
      const events = await auxiliaryEvents(dir, 2);
      expect(events.map((row) => row.auxPurpose).sort()).toEqual(["episode", "memory-extraction"]);
      expect(new Set(events.map((row) => row.stepId)).size).toBe(2);
      for (const event of events) {
        expect(event).toMatchObject({ agentId: "agent-tom", turnId: E07_TURN, parentStepId: E07_STEP });
        expect(event.stepId).not.toBe(E07_STEP);
      }
      for (const request of requests) {
        expect(request.text).toContain(SYNTHETIC_OPENAI.model);
        expect(request.text).not.toContain("grokboxAux");
      }
      expect(requests[1]!.text).not.toContain("main-window-not-aux");
    } });
  }, 20_000);

  test("E07 missing parent, mismatched TURN, and failed newest main STEP never fall back to official", async () => {
    await withFakeHttpSession({ turnId: E07_TURN, fn: async ({ dir, requests }) => {
      const f = await fixture(dir);
      await expect(f.memory()).rejects.toThrow();
      expect(requests).toHaveLength(0);
      await f.main.stream(f.ctx, E07_STEP).response;
      await expect(f.memory([], f.host.fixtureContext("other-turn"))).rejects.toThrow();
      await expect(f.session.getExecutor({ bad: "window" }).stream(f.ctx, "bad-main-step").response).rejects.toThrow();
      await expect(f.memory()).rejects.toThrow();
      expect(requests).toHaveLength(1);
      expect(f.memories).toEqual([]);
      expect(f.host.fixtureOfficial).toEqual([]);
      expect(grokboxAuxFrom(f.ctx)).toBeUndefined();
    } });
  }, 20_000);

  test("E07 pending main is not a parent; late completion cannot relabel an earlier auxiliary attempt", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    await withFakeHttpSession({ turnId: E07_TURN, hold, fn: async ({ dir, requests, admitted }) => {
      const f = await fixture(dir);
      const main = f.main.stream(f.ctx, E07_STEP);
      await admitted;
      const aux = wrapHostAuxExecutor({ executor: f.session.getExecutor([{ role: "system", content: "aux-root" }]), purpose: "episode", turnId: E07_TURN, ctx: f.ctx })!;
      try {
        await expect(aux.stream(f.ctx).response).rejects.toThrow();
      } finally { release(); }
      await main.response;
      await expect(aux.stream(f.ctx).response).rejects.toThrow();
      expect(requests).toHaveLength(1);
    } });
  }, 20_000);

  test("E07 duplicate and stale aux, foreign ctx, tools and malformed options do not dispatch again", async () => {
    await withFakeHttpSession({ turnId: E07_TURN, fn: async ({ dir, requests }) => {
      const f = await fixture(dir);
      await f.main.stream(f.ctx, E07_STEP).response;
      const createAux = () => wrapHostAuxExecutor({ executor: f.session.getExecutor([{ role: "system", content: "aux-root" }, { role: "user", content: "extract" }]), purpose: "episode", turnId: E07_TURN, ctx: f.ctx })!;
      const aux = createAux();
      await aux.stream(f.ctx).response;
      await expect(aux.stream(f.ctx).response).rejects.toThrow();
      expect(requests).toHaveLength(2);
      await expect(createAux().stream({}, undefined).response).rejects.toThrow();
      await expect(createAux().stream(f.ctx, undefined, [{ name: "lookup", inputSchema: { type: "object" } }]).response).rejects.toThrow();
      await expect(createAux().stream(f.ctx, undefined, undefined, "bad-options").response).rejects.toThrow();
      await expect(createAux().stream(f.ctx, "aux-must-not-also-be-a-STEP").response).rejects.toThrow();
      expect(requests).toHaveLength(2);
      await f.main.stream(f.ctx, "next-real-step").response;
      await expect(aux.stream(f.ctx).response).rejects.toThrow();
      expect(requests).toHaveLength(3);
      expect(f.host.fixtureOfficial).toHaveLength(0);
    } });
  }, 20_000);

  test("E07 evidence-only and dedicated external stay official; self-summary still needs a STEP", async () => {
    await withFakeHttpSession({ turnId: E07_TURN, fn: async ({ dir, requests }) => {
      const f = await fixture(dir);
      const evidence: unknown[] = [];
      await f.host.runTurnMemory({ recordMemoryEvidence: (row) => { evidence.push(row); } }, [1, 2], f.session, f.ctx, 1, { user: "note", agent: "answer" });
      expect(evidence).toHaveLength(1);
      expect(requests).toHaveLength(0);
      await f.main.stream(f.ctx, "self-summary-step").response;
      expect(requests).toHaveLength(1);
      const official = await f.host.fixtureSession("unassigned-external");
      await f.host.runTurnMemory({ addMemory() {} }, [1, 2], official, f.ctx, 1, { user: "purpose: episode", agent: "note" });
      expect(f.host.fixtureOfficial).toHaveLength(2);
      for (const call of f.host.fixtureOfficial) expect(grokboxAuxFrom(call.ctx)).toBeUndefined();
      expect(requests).toHaveLength(1);
    } });
  }, 20_000);

  test.each([2, 3])("E07 half-stream failure at request %s cannot commit partial Memory", async (failedRequest) => {
    await withFakeHttpSession({ turnId: E07_TURN, respond: (n) => n !== failedRequest ? sseChatOk() : new Response(
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "partial-fact-must-not-commit" }, finish_reason: null }] })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ), fn: async ({ dir, requests }) => {
      const f = await fixture(dir);
      await f.main.stream(f.ctx, E07_STEP).response;
      const before = f.main.getState();
      await expect(f.memory([1, 2])).rejects.toThrow();
      expect(f.memories).toEqual(failedRequest === 2 ? [] : [{ purpose: "memory-extraction", text: "ok" }]);
      expect(f.main.getState()).toEqual(before);
      expect(requests).toHaveLength(failedRequest);
      expect(f.host.fixtureOfficial).toHaveLength(0);
    } });
  }, 20_000);

  test("E07 canceled auxiliary fullStream rejects instead of committing an empty/partial success", async () => {
    await withFakeHttpSession({ turnId: E07_TURN, fn: async ({ dir, requests }) => {
      const f = await fixture(dir);
      await f.main.stream(f.ctx, E07_STEP).response;
      const abort = new AbortController();
      abort.abort();
      const ctx = f.host.fixtureContext(E07_TURN, abort.signal);
      await expect(f.memory([1, 2], ctx)).rejects.toThrow();
      expect(f.memories).toEqual([]);
      expect(requests).toHaveLength(1);
    } });
  }, 20_000);
});
