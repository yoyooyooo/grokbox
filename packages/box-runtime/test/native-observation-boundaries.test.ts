import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { NATIVE_CHECKPOINT_PAIR } from "../src/internal/host/native-checkpoint-worker-hook.ts";
import { profileFromSource, applyPatchProfile } from "../src/internal/host/profile.ts";
import { createRunObserver, HOST_RUN_OBSERVATION_SYMBOL, type NativeToolObservation } from "../src/internal/host/run-observation.ts";

// Private native source is used only under this explicit qualification flag.
// Nothing from that source is copied into a fixture, artifact or report.
const nativeTest = test.skipIf(process.env.GROKBOX_TEST_NATIVE_CONTINUITY !== "1");
let transformed: string | undefined;
function qualified() {
  if (transformed) return transformed;
  const original = readFileSync(LIVE_HOST_BUNDLE, "utf8");
  expect(sha256Text(original)).toBe(NATIVE_CHECKPOINT_PAIR.host);
  const profile = profileFromSource(original, LIVE_SLICE_PATCHES);
  const result = applyPatchProfile(original, profile);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error("native_observation_recipe_mismatch");
  transformed = result.source; return transformed;
}
function toolHandlerSource() {
  const text = qualified(), parsed = ts.createSourceFile("owned-native.cjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches: string[] = [];
  function walk(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === "executeToolCall"
      && node.parameters.map(p => p.name.getText(parsed)).join(",") === "parentCtx,toolCall,callId,promiseFn,resultMergeFn,hookContextCollector") matches.push(node.getText(parsed));
    ts.forEachChild(node, walk);
  }
  walk(parsed); expect(matches).toHaveLength(1); return matches[0]!;
}

nativeTest("the complete reviewed-source profile compiles with both new producer observations", () => {
  const source = qualified();
  expect(source).toContain("__grokbox_tool_observation?.finish(true)");
  expect(source).toContain("__grokbox_tool_observation?.finish(false)");
  expect(source).toContain("runObservation");
}, 20000);

for (const fails of [false, true]) nativeTest(`actual native tool promise ${fails ? "failure" : "success"} records the same original result and no extra execution`, async () => {
  const events: NativeToolObservation[] = [];
  const observer = createRunObserver({ generation: "native-source-generation", instrumented: true, emit: () => undefined, emitTool: event => events.push(event) });
  const controller = new AbortController(), ctx = { withName() { return this; }, get() { return "turn-one"; } };
  const globals: Record<string | symbol, unknown> = {
    Promise, Symbol, Date,
    __addDisposableResource5: (_env: unknown, resource: unknown) => resource,
    __disposeResources5: (env: { hasError: boolean; error: unknown }) => { if (env.hasError) throw env.error; },
    createSpan: (value: unknown) => ({ ctx: value }), requestIdKey: Symbol("request"),
    Updates: { toolCallStarted: () => ({ phase: "started" }), toolCallCompleted: () => ({ phase: "completed" }) },
    toolCallLatency: { histogram() {} }, toolCallCount: { increment() {} },
    toRedactedToolCall: (v: unknown) => v, PrivacyMode: { UNSPECIFIED: 0 }, logger17: { warn() {} },
    ToolCallAbortedError: class extends Error {},
    [Symbol.for(HOST_RUN_OBSERVATION_SYMBOL)]: observer,
  };
  const api = runInNewContext(`({${toolHandlerSource()}})`, globals, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  let executions = 0, recorded = 0, updates = 0;
  Object.assign(api, { invocationId: "step-one", getOrCreateToolCallStartedAtMs: () => Date.now(),
    withToolCallMetadata: (_id: unknown, value: unknown) => value, rememberLatestToolCall() {},
    getAbortSignal: () => controller.signal, interactionProvider: { sendUpdate: async () => { updates++; } },
    toolCallStartedAtMsByCallId: new Map(), latestToolCallsById: new Map(), shouldPreserveArgsOnErrorCallIds: new Set(),
    toolCallRecorder: { recordToolCall() { recorded++; } } });
  const nativeFailure = Error("OWNED_NATIVE_FAILURE"), result = { externalMarker: "OWNED_RESULT" };
  const queued = observer.queue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", () => api.executeToolCall(ctx,
    { tool: { case: "shellToolCall" } }, "call-one", async () => { executions++; if (fails) throw nativeFailure; return result; },
    () => ({ tool: { case: "shellToolCall" }, hookAdditionalContexts: [] }), []), { source: "turn" });
  if (fails) await expect(queued.task()).rejects.toBe(nativeFailure);
  else expect(await queued.task()).toBe(result);
  expect(executions).toBe(1); expect(recorded).toBe(fails ? 0 : 1); expect(updates).toBe(fails ? 1 : 2);
  expect(events.map(e => e.state)).toEqual(["native_started", fails ? "failed" : "returned"]);
  expect(events.every(e => e.externalCommitObserved === false)).toBe(true);
  expect(JSON.stringify(events)).not.toContain("OWNED_NATIVE_FAILURE"); expect(JSON.stringify(events)).not.toContain("OWNED_RESULT");
}, 20000);
