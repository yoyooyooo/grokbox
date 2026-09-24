import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { validateContextReplacement } from "@grokbox/runtime-kernel/inference";
import { captureContextPolicy, contextBudget, summaryBudget } from "@grokbox/runtime-kernel/config";
import type { ContextCandidate } from "@grokbox/runtime-kernel/contract";
import { createNativeContextOwner } from "../src/internal/host/context-maintenance.ts";
import { planPiCompaction } from "../src/internal/context/pi-projection.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { NATIVE_HOST_BUNDLE as LIVE_HOST_BUNDLE } from "./native-host-source.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import { nativeHostQualificationEnabled, QUALIFIED_NATIVE_HOST_SHA } from "./native-host-qualification.ts";

// Actual pinned native methods execute in a VM. Only external blob storage,
// telemetry, project lookup and privacy wrappers are substituted. No complete
// Host import/start, provider call, private source copy or native state mutation.
test.skipIf(!nativeHostQualificationEnabled())("pinned native summarizer and archive/accept pipeline consume the managed candidate without a second inference", async () => {
  const source = readFileSync(LIVE_HOST_BUNDLE, "utf8");
  expect(createHash("sha256").update(source).digest("hex")).toBe(QUALIFIED_NATIVE_HOST_SHA);
  const transformed = transformUnchecked(source, LIVE_SLICE_PATCHES);
  expect(transformed.ok).toBe(true);
  // Parse bounded, uniquely named declarations rather than the entire Host.
  // The exact source pin and AST shape checks still reject changed layouts.
  const selected = (marker: string, endMarker: string, endLength: number, maxBytes: number) => {
    const start = source.indexOf(marker), end = source.indexOf(endMarker, start + marker.length);
    if (start < 0 || source.indexOf(marker, start + marker.length) !== -1 || end < 0 || end - start > maxBytes)
      throw Error("native_summary_declaration_layout");
    return source.slice(start + 1, end + endLength);
  };
  const parse = (code: string) => {
    const parsed = ts.createSourceFile("qualified-selected.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if ((parsed as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length) throw Error("native_summary_declaration_syntax");
    return parsed;
  };
  const wanted = ["isInjectedReminderMessage", "runSummarizationPipeline", "warnIfPreservedTailShapeInvalid", "prepareMessagesForCompaction", "hasUserInfoTag", "isEmptyAssistantMessage3", "placedBlockIds", "selectBlockPrompts", "renderDurableBlocks", "appendDurableBlocks", "extractManuallyAttachedSkillBlocks", "collectAllSkillBlocks", "getContextUsageInfo"];
  const functions = new Map<string, string>(), methods = new Map<string, string>();
  for (const name of wanted) {
    const parsed = parse(selected(`\nfunction ${name}(`, "\n}", 2, 40 * 1024)), statement = parsed.statements[0];
    if (parsed.statements.length !== 1 || !statement || !ts.isFunctionDeclaration(statement) || statement.name?.text !== name)
      throw Error("native_summary_function_shape");
    functions.set(name, statement.getText(parsed));
  }
  const flagsFile = parse(selected("\nvar INJECTED_REMINDER_CURSOR_FLAGS = ", ";\n", 1, 8192));
  const flagStatement = flagsFile.statements[0];
  if (flagsFile.statements.length !== 1 || !flagStatement || !ts.isVariableStatement(flagStatement)
    || flagStatement.declarationList.declarations.length !== 1) throw Error("native_reminder_flags_declaration");
  const flags = flagStatement.declarationList.declarations[0]!;
  if (flags.name.getText(flagsFile) !== "INJECTED_REMINDER_CURSOR_FLAGS" || !flags.initializer
    || !ts.isArrayLiteralExpression(flags.initializer) || !flags.initializer.elements.every(ts.isStringLiteral))
    throw Error("native_reminder_flags_shape");
  const reminderFlags = `const ${flags.getText(flagsFile)};`;
  const summaryFile = parse(selected("\nvar SummarizationHandler = ", "\n};", 3, 128 * 1024));
  const statement = summaryFile.statements[0];
  if (summaryFile.statements.length !== 1 || !statement || !ts.isVariableStatement(statement)
    || statement.declarationList.declarations.length !== 1) throw Error("native_summary_owner_shape");
  const declaration = statement.declarationList.declarations[0]!;
  if (declaration.name.getText(summaryFile) !== "SummarizationHandler" || !declaration.initializer || !ts.isClassExpression(declaration.initializer))
    throw Error("native_summary_owner_class");
  for (const name of ["partitionMessages", "buildSummaryMessage", "assembleFinalMessages", "summarize"]) {
    const found = declaration.initializer.members.filter(m => ts.isMethodDeclaration(m) && m.name.getText(summaryFile) === name);
    if (found.length !== 1) throw Error("native_summary_method_ambiguous"); methods.set(name, found[0]!.getText(summaryFile));
  }
  const handleFile = parse(`class Selected {${selected("\n  async handleSummarization(", "\n  }", 4, 64 * 1024)}}`);
  const handleOwner = handleFile.statements[0];
  if (handleFile.statements.length !== 1 || !handleOwner || !ts.isClassDeclaration(handleOwner) || handleOwner.members.length !== 1
    || !ts.isMethodDeclaration(handleOwner.members[0]!) || handleOwner.members[0]!.name.getText(handleFile) !== "handleSummarization")
    throw Error("native_summary_handle_shape");
  const nativeHandle = handleOwner.members[0]!.getText(handleFile);
  console.log(JSON.stringify({ nativeSummarySource: QUALIFIED_NATIVE_HOST_SHA,
    declarations: Object.fromEntries([...functions, ...methods, ["handleSummarization", nativeHandle], ["reminderFlags", reminderFlags]]
      .map(([name, code]) => [name, createHash("sha256").update(code!).digest("hex")])), fullHostExecuted: false }));
  const lifecycle: string[] = [], blobs = new Map<string, unknown>(), archive: any[] = [];
  const metric = { increment() {}, histogram() {} }, log = { info() {}, warn() {}, error() {} };
  const awaiter = (self: unknown, _args: unknown, _promise: unknown, factory: () => Generator) => new Promise((resolve, reject) => {
    const generator = factory.call(self);
    const step = (kind: "next" | "throw", value?: unknown) => {
      try { const next = generator[kind](value); if (next.done) resolve(next.value); else Promise.resolve(next.value).then(value => step("next", value), error => step("throw", error)); }
      catch (error) { reject(error); }
    }; step("next");
  });
  const globals: Record<string, unknown> = {
    performance, Promise, Object, Map, Set, Symbol,
    __awaiter28: awaiter, __awaiter29: awaiter,
    __addDisposableResource20: (_env: unknown, value: unknown) => value,
    __disposeResources20(env: { hasError: boolean; error: unknown }) { if (env.hasError) throw env.error; },
    createSpan: (ctx: unknown) => ({ ctx }),
    logger6: log, logger7: log, logger60: log,
    PrivacyMode: { UNSPECIFIED: 0 }, PrivacyCapability: { UNSAFE_ALWAYS_ALLOWED: 0 }, DataClassification: { CODE: 0 },
    fromRedactedCoreMessages: (rows: unknown[]) => rows, fromRedactedCoreMessage: (row: unknown) => row,
    toRedactedCoreMessage: (row: unknown) => row, isRedactedString: () => false,
    createRedactedString: (text: string) => ({ safeTransform: (map: (text: string) => string) => map(text) }), USER_INFO_TAG_REGEX: /<user_info>[\s\S]*<\/user_info>/,
    MANUALLY_ATTACHED_SKILLS_REGEX: /<manually_attached_skills>[\s\S]*?<\/manually_attached_skills>/g,
    PREVIOUS_CONVERSATION_SUMMARY_PREFIX: "[Previous conversation summary]:", BLOCK_SEPARATOR: "\n\n",
    SUMMARIZERS: { external: { leading: [], trailing: ["todos", "mode"] } },
    BLOCK_RENDERERS: { todos: { render: (e: any) => e.todoContent }, mode: { render: (e: any) => e.modePrompt } },
    resolveProjectConversationContext: async () => ({ lastMode: "agent", isRootProject: false }),
    processModeSystemReminder: () => "NATIVE_MODE=retained", formatTodosForSummarization: () => "NATIVE_TODO=retained",
    BackgroundSummarizationMode: { Background: "Background", BackgroundAndPersistIfCompleted: "BackgroundAndPersistIfCompleted", WaitForCompletion: "WaitForCompletion", WaitForCompletionIfStarted: "WaitForCompletionIfStarted" },
    createLiveSummaryLifecycle: () => ({ summaryLifecycleId: "owned-lifecycle" }),
    emitSummaryLifecycleStarted: () => lifecycle.push("started"), emitSummaryLifecycleCompleted: () => lifecycle.push("generated"),
    emitSummaryLifecyclePersisted: () => lifecycle.push("persisted"), emitSummaryLifecycleAbandoned: () => lifecycle.push("abandoned"),
    RedactedUpdates: { summaryStarted: () => ({ type: "summary-started" }) }, Updates: { summaryCompleted: () => ({ type: "summary-completed" }) },
    toRedactedInteractionUpdate: (value: unknown) => value,
    createRedactedCoreMessageSerde: () => ({ serialize: (value: unknown) => JSON.stringify(value) }),
    createRedactedConversationSummaryArchive: (_privacy: unknown, value: unknown) => value,
    getBlobId: async (value: string) => createHash("sha256").update(value).digest("hex"),
    estimateTokenCount2: (rows: unknown[]) => Math.ceil(JSON.stringify(rows).length / 4),
    messagesEqualByValue: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    collectLiveAskQuestionOriginalIds: () => [],
    countMessageKinds: () => ({ userMessages: 1, systemMessages: 1, assistantMessages: 1, toolMessages: 0, toolCalls: 0 }),
    getAgentEventTracker: () => ({ trackSummarizationTriggered() {}, trackSummarizationPersistedForQualityGrading() {} }),
    getClientVersionMetricTagsFromContext: () => ({}),
    getRetryDirective: (error: Error) => ({ errorType: error.name }),
  };
  for (const name of ["summaryBlockingDurationMs", "timeBetweenLastTwoMessagesMs", "backgroundSummarizationDiscarded", "backgroundSummarizationStarted", "summarizationGenerationTime", "backgroundSummarizationPersisted", "backgroundSummarizationPersistedEstimatedTokens", "backgroundSummarizationPersistedAdditionalMessages", "summarizationTime", "backgroundSummarizationTimeSavedMs", "summarizationCounter"]) globals[name] = metric;
  const module = { exports: {} as { summary: new () => any; orchestrator: new () => any; reminderFlags: readonly string[]; isReminder: (message: unknown) => boolean } };
  runInNewContext(`${reminderFlags}\n${[...functions.values()].join("\n")}\nclass Summary {
    getMetricsModelLabel() { return "qualified-native"; }
    recordMetrics() {}
    generateSummary() { throw new Error("native_provider_call_forbidden"); }
    ${[...methods.values()].join("\n")}
  }\nclass Orchestrator { getSummarizer() { return new Summary(); } ${nativeHandle} }\nmodule.exports={summary:Summary,orchestrator:Orchestrator,reminderFlags:INJECTED_REMINDER_CURSOR_FLAGS,isReminder:isInjectedReminderMessage};`, { ...globals, module });
  // Exercise the newly observed native reminder dependency, including its
  // real flag constants. An absent global must not hide behind an unvisited branch.
  expect(module.exports.reminderFlags.length).toBeGreaterThan(0);
  for (const flag of module.exports.reminderFlags) {
    expect(module.exports.isReminder({ role: "user", content: "owned reminder", providerOptions: { cursor: { [flag]: true } } })).toBe(true);
    expect(module.exports.isReminder({ role: "assistant", content: "owned assistant", providerOptions: { cursor: { [flag]: true } } })).toBe(false);
  }
  expect(module.exports.isReminder({ role: "user", content: "owned input", providerOptions: { cursor: {} } })).toBe(false);
  let rows: any[] = [{ role: "system", content: "Native system", providerOptions: { future: { id: "system" } } },
    { role: "user", content: "<user_info>fixed</user_info>" },
    ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `FACT_${i}=value; ${"history ".repeat(1000)}` })),
    { role: "user", content: "NEW_INPUT=one", providerOptions: { future: { nonce: "one" } } }];
  const before = structuredClone(rows);
  const state: any = { summaryArchives: archive, tokenDetails: { usedTokens: 100000, maxTokens: 500000 }, todos: [], durableSkillBlocks: [], lastStepInvocationId: "step",
    backgroundSummarizationPromiseInfo: null, messagesUndergoingSummarization: null,
    resolveStepMode: () => "agent", getPrivacyMode: () => 0,
    getBlobStore: () => ({ setBlob: async (_ctx: unknown, id: string, value: unknown) => { blobs.set(id, value); } }),
    setBackgroundSummarizationHasCompleted() { this.backgroundSummarizationHasCompleted = true; },
    setBackgroundSummarizationState(info: unknown, messages: unknown, token: unknown) { this.backgroundSummarizationPromiseInfo = info; this.messagesUndergoingSummarization = messages; this.backgroundSummarizationCancellationToken = token; },
    clearBackgroundSummarizationState() { this.backgroundSummarizationPromiseInfo = null; this.messagesUndergoingSummarization = null; },
    pushSummaryArchive: (value: unknown) => archive.push(value), retainCompletedAskQuestionReceipts() {}, clearSelfSummaryInputLimitFailureTokenCount() {},
  };
  let checkpoints = 0;
  const ctx: any = { signal: new AbortController().signal, withName() { return this; } };
  const owner = createNativeContextOwner({ orchestrator: new module.exports.orchestrator(), stateHandler: state,
    rootPromptExecutor: { getMessages: () => rows, clearMessages: () => { rows = []; }, appendMessages: (next: any[]) => rows.push(...next) },
    ctx, config: {}, requestContext: {}, resourceAccessor: {}, interactionListener: { sendUpdate: async () => {} },
    invocationId: "step", turnId: "turn", agentId: "agent", sessionId: "", modelId: "owned/model",
    normalize: rows => structuredClone(rows), fixedMessages: () => rows.slice(0, 2), tools: () => [], checkpoint: async () => { checkpoints++; }, valid: () => true });
  const material = owner.inspect();
  const policy = captureContextPolicy({ windowTokens: 32000, compaction: { reserveTokens: 4096, keepRecentTokens: 512 } }, "owned/model", "agent");
  const budget = contextBudget(policy, 500000), plan = planPiCompaction(material, budget, summaryBudget(policy, 500000).inputTokens);
  const candidate: ContextCandidate = { operationId: "native-qualified", sourceRootRevision: material.rootRevision, summary: "FACT_0=value; continue new input.",
    summarizedRefs: plan.summarizedRefs, retainedRefs: plan.retainedRefs, budget };
  try {
    const preview = await owner.preview(candidate);
    expect(rows).toEqual(before);
    validateContextReplacement(material, candidate, preview);
    expect(JSON.stringify(preview)).toContain("NATIVE_TODO=retained");
    expect(JSON.stringify(preview)).toContain("NATIVE_MODE=retained");
    expect((await owner.commit(candidate)).persisted).toBe(true);
    expect(checkpoints).toBe(1); expect(archive).toHaveLength(1); expect(blobs.size).toBeGreaterThan(1);
    expect(rows.at(-1)).toEqual(before.at(-1)); expect(lifecycle).toEqual(["started", "generated", "persisted"]);
    expect(state.backgroundSummarizationPromiseInfo).toBeNull();
  } finally { await owner.close(); }
}, 20000);
