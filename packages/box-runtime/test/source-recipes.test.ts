import { expect, test } from "bun:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { IDLE_COMPACTION_HOST_SHA, IDLE_COMPACTION_RECIPE, hostRecipeForSourceSha } from "../src/internal/host/source-recipes.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { NATIVE_CURRENT_STATE_SLICES } from "../src/internal/host/native-current-state-slices.ts";
import { NATIVE_CHECKPOINT_PAIR } from "../src/internal/host/native-checkpoint-pair.ts";
import { HOST_CONTEXT_CONTROL_SYMBOL } from "../src/internal/host/context-control.node.ts";
import { NATIVE_CURRENT_STATE_SYMBOL } from "../src/internal/host/native-current-state-owner.ts";
import { HOST_MANAGED_FAILURE_SYMBOL, transformUnchecked, applyPatchProfile, type SlicePatch } from "../src/internal/host/profile.ts";
import { HOST_RUN_OBSERVATION_SYMBOL } from "../src/internal/host/run-observation.ts";
import { HOST_ALERT_OBSERVATION_SYMBOL } from "../src/internal/host/alert-observation.ts";
import { writeReviewedProfileFromCopy } from "../src/internal/process/profile.node.ts";

const fixture = (name: string) => readFile(new URL(`../../../test/fixtures/host-verifier/sources/${name}.cjs`, import.meta.url), "utf8");
const all = [...IDLE_COMPACTION_RECIPE.core, ...IDLE_COMPACTION_RECIPE.currentState];
const select = (...ids: string[]) => all.filter(s => ids.includes(s.id));
function execute(source: string, slices: readonly SlicePatch[], globals: Record<PropertyKey, unknown> = {}) {
  const changed = transformUnchecked(source, slices);
  if (!changed.ok) throw Error(`fixture_transform:${changed.code}:${changed.sliceId}`);
  const module = { exports: {} as any };
  runInNewContext(changed.source, { module, ...globals }, { timeout: 1000 });
  return module.exports as any;
}

test("only the inspected source selects the new authoring layout; existing profile and companion pins are unchanged", () => {
  expect(hostRecipeForSourceSha(IDLE_COMPACTION_HOST_SHA)).toBe(IDLE_COMPACTION_RECIPE);
  expect(hostRecipeForSourceSha("a".repeat(64)).core).toBe(LIVE_SLICE_PATCHES);
  expect(hostRecipeForSourceSha(NATIVE_CHECKPOINT_PAIR.host).currentState).toBe(NATIVE_CURRENT_STATE_SLICES);
  expect(NATIVE_CHECKPOINT_PAIR.host).not.toBe(IDLE_COMPACTION_HOST_SHA);
  expect(IDLE_COMPACTION_RECIPE.core.map(s => s.id)).toEqual(LIVE_SLICE_PATCHES.map(s => s.id));
  expect(IDLE_COMPACTION_RECIPE.currentState.map(s => s.id)).toEqual(NATIVE_CURRENT_STATE_SLICES.map(s => s.id));
  expect(IDLE_COMPACTION_RECIPE.core.filter((s, i) => JSON.stringify(s) !== JSON.stringify(LIVE_SLICE_PATCHES[i])).map(s => String(s.id)).sort()).toEqual([
    "managed-retry-gate", "managed-output-retry-gate", "managed-summary-retry-gate", "tool-execution-failure-observation", "alert-main-decision", "alert-automation-decision", "alert-automation-throttle", "context-manual-native-action", "context-manual-summary-owner",
  ].sort());
  expect(IDLE_COMPACTION_RECIPE.currentState.filter((s, i) => JSON.stringify(s) !== JSON.stringify(NATIVE_CURRENT_STATE_SLICES[i])).map(s => String(s.id)).sort()).toEqual(["continuity-native-created-owner", "continuity-native-session-owner", "continuity-native-startup-action", "continuity-native-startup-input"]);
});

const actionIds = ["context-manual-trusted-options", "context-manual-native-action", "continuity-native-startup-input", "continuity-native-startup-action"];
test("ordinary empty input, resume and native idle summary retain distinct branches with zero synthetic user messages", async () => {
  const source = await fixture("idle-actions");
  expect(transformUnchecked(source, NATIVE_CURRENT_STATE_SLICES.filter(s => s.id === "continuity-native-startup-input")).ok).toBe(false);
  let assembly = 0, consume = 0;
  const e = execute(source, select(...actionIds), { [Symbol.for(NATIVE_CURRENT_STATE_SYMBOL)]: { consumeStartup: () => { consume++; return false; } } });
  const shell = e.createTurnRunShell({ getConversationId: () => "source", promptGlue: { assembleTurnAction: async () => { assembly++; return { action: { kind: "ordinary" } }; } } });
  await expect(shell.run("", {})).rejects.toBeInstanceOf(e.SandEmptyPromptError);
  expect((await shell.run("", { idleCompaction: {} })).action).toBe(e.SUMMARIZE_ACTION);
  expect((await shell.run("", { resumeTurn: true })).action).toBe(e.RESUME_TURN_ACTION);
  expect((await shell.run("", { resumeTurn: true, idleCompaction: {} })).action).toBe(e.SUMMARIZE_ACTION);
  expect(assembly).toBe(0);
  expect((await shell.run("hello", {})).action.kind).toBe("ordinary"); expect(assembly).toBe(1); expect(consume).toBe(5);
});

test("a trusted manual operation overrides only its own action; startup still consumes one private ticket without prompt assembly", async () => {
  let assembly = 0; const manual = new WeakSet<object>(), tickets = new Set<object>();
  const ticket = {}; tickets.add(ticket);
  const e = execute(await fixture("idle-actions"), select(...actionIds), {
    [Symbol.for(HOST_CONTEXT_CONTROL_SYMBOL)]: { manualOptions: (_host: unknown, options: object) => manual.has(options) ? "original-op" : undefined },
    [Symbol.for(NATIVE_CURRENT_STATE_SYMBOL)]: { consumeStartup: (_id: string, t: object) => tickets.delete(t), startupMessageId: () => "synthetic-original-startup" },
  });
  const shell = e.createTurnRunShell({ getConversationId: () => "source", promptGlue: { assembleTurnAction: () => { assembly++; throw Error("unexpected-prompt"); } } });
  const selected = {}; manual.add(selected);
  expect((await shell.run("", selected)).action.action.case).toBe("summarizeAction");
  const started = await shell.run("", { grokboxStartupTicket: ticket });
  expect(started.action.action.case).toBe("userMessageAction");
  expect(started.action.action.value.userMessage).toMatchObject({ text: "", isSimulatedMsg: true, messageId: "synthetic-original-startup" });
  expect(started.action.action.value.sendToInteractionListener).toBe(false);
  await expect(shell.run("", { grokboxStartupTicket: ticket })).rejects.toBeInstanceOf(e.SandEmptyPromptError);
  expect(assembly).toBe(0); expect(tickets.size).toBe(0);
});

test("unclaimed summaries keep the native idle-threshold path, while the manual capture retains the real MCP argument binding", async () => {
  let manual = false, captured: any, receivedTools: unknown; const tools = [{ name: "owned-tool" }];
  const e = execute(await fixture("idle-actions"), select("context-manual-summary-owner"), {
    [Symbol.for(HOST_CONTEXT_CONTROL_SYMBOL)]: { manualAction: (input: any) => manual ? input.capture().then((v: unknown) => { captured = v; }) : undefined },
  });
  const config = { summarizeActionMode: "threshold", conversationGroupId: "owned", toolsGenerator: (input: any) => { receivedTools = input.mcpTools; return {}; } };
  const handler = new e.SummarizeActionHandler(config), root = { getMessages: () => ["retained"] };
  const state = { computeNewStructure: async () => "stored-structure", getBlobStore: () => ({}) }, ctx = { get: () => "owned-turn" };
  expect((await handler.handle(ctx, {}, root, state, tools, () => {})).kind).toBe("native-idle-threshold"); expect(receivedTools).toBeUndefined();
  manual = true; expect(await handler.handle(ctx, {}, root, state, tools, () => {})).toBe("stored-structure");
  expect(receivedTools).toBe(tools); expect(captured.rootPromptExecutor).toBe(root); expect(captured.stateHandler).toBe(state);
});

test("renamed retry catches preserve original exception identity and refuse only managed failures", async () => {
  const managed = new WeakSet<object>();
  const e = execute(await fixture("retry-observations"), select("managed-retry-gate", "managed-output-retry-gate", "managed-summary-retry-gate"), {
    [Symbol.for(HOST_MANAGED_FAILURE_SYMBOL)]: (value: object) => managed.has(value),
  });
  const owner = new e.RetryOwner(), retriable = new e.RetriableError(); expect(e.isRetryableProviderError(retriable)).toBe(true);
  managed.add(retriable); expect(e.isRetryableProviderError(retriable)).toBe(false);
  for (const [method, ErrorType, kind] of [["runWithMaxTokensRetry", e.OutputTokensLimitExceededError, "output"], ["runWithSummarizationRetry", e.ProactiveSummarizationThresholdError, "summary"]]) {
    const error = new ErrorType(), work = async () => { throw error; };
    expect(await owner[method](work)).toMatchObject({ retry: kind, original: error }); managed.add(error);
    await expect(owner[method](work)).rejects.toBe(error);
  }
});

test("renamed tool failure captures one failure and still rejects the same native object when observation throws", async () => {
  const finished: boolean[] = [];
  const e = execute(await fixture("retry-observations"), select("tool-execution-observation", "tool-execution-failure-observation"), {
    [Symbol.for(HOST_RUN_OBSERVATION_SYMBOL)]: { tool: () => ({ finish: (ok: boolean) => { finished.push(ok); throw Error("observer"); } }) },
  });
  const tool = new e.ToolOwner(), error = { original: true };
  await expect(tool.executeToolCall({}, {}, "call", async () => { throw error; })).rejects.toBe(error);
  expect(await tool.executeToolCall({}, {}, "call", async () => "result")).toBe("result"); expect(finished).toEqual([false, true]);
});

test("renamed alert descriptions preserve epoch suppression, native throttling and the original error", async () => {
  const decisions: unknown[] = [], suppressed: string[] = [];
  const e = execute(await fixture("retry-observations"), select("alert-main-decision", "alert-automation-decision", "alert-automation-throttle"), {
    [Symbol.for(HOST_ALERT_OBSERVATION_SYMBOL)]: { decision: (error: unknown, _facts: unknown, emit: boolean, native: () => void) => { decisions.push([error, emit]); native(); }, suppressed: (_id: string, reason: string) => suppressed.push(reason) },
  });
  const owner = new e.AlertOwner(), error = { original: true }; owner.epoch = 2;
  await owner.run(error, 1); expect(owner.trays).toHaveLength(0);
  await owner.run(error, 2); expect(owner.trays).toHaveLength(1); expect(owner.trays[0].error).toBe(error);
  owner.notifyAutomationFailure({ id: "owned" }, { occurrence: "ready" }, "background", {});
  owner.notifyAutomationFailure({ id: "owned" }, { occurrence: "throttled" }, "cron", {});
  expect(owner.trays).toHaveLength(1); expect(suppressed).toEqual(["background_automation", "native_rate_limit"]);
  expect(decisions).toEqual([[error, false], [error, true]]);
});

test("the original profile publisher persists an exact candidate and still rejects changed source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-layout-"));
  try {
    const source = (await Promise.all([fixture("contracts"), fixture("idle-actions"), fixture("retry-observations")])).join("\n");
    const slices = select("create-session", "agent-id", ...actionIds, "context-manual-summary-owner", "managed-retry-gate", "managed-output-retry-gate", "managed-summary-retry-gate", "tool-execution-observation", "tool-execution-failure-observation", "alert-main-decision", "alert-automation-decision", "alert-automation-throttle");
    const path = join(root, "host.cjs"); await writeFile(path, source, { mode: 0o600 });
    await writeReviewedProfileFromCopy({ hostBundle: path, destDir: join(root, "profile"), slices, profileId: "public-layout" });
    const profile = JSON.parse(await readFile(join(root, "profile", "reviewed.json"), "utf8"));
    expect(applyPatchProfile(source, profile).ok).toBe(true);
    expect(applyPatchProfile(source + "\n// next-source", profile)).toMatchObject({ ok: false, code: "unknown-sha" });
    expect(await readFile(path, "utf8")).toBe(source);
  } finally { await rm(root, { recursive: true, force: true }); }
});
