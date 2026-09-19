import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { assessEvidenceCoverage, projectExecutionBoundary, projectNativeRunHealth,
  type EvidenceFact } from "@grokbox/runtime-kernel/observation";
import { asHostPromptSession, type PromptSession } from "../src/internal/host/session.ts";
import { createRunObserver, type NativeToolObservation, type RunObservation } from "../src/internal/host/run-observation.ts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { readJournalBatch } from "../src/internal/io/journal-cursor.node.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", GEN = "b".repeat(64), BUILD = "c".repeat(64);
const build = { version: 1, kind: "bundled", sourceDigest: BUILD, compilerVersion: "1.3.14", sdkVersions: { ai: "6.0.0", openai: "3.0.0", effect: "4.0.0-beta.107" } };
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => release = r); return { release, promise }; };
const identity = { hostGenerationId: GEN, agentId: AGENT, turnId: "turn-one", stepId: "step-one" };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "producer-boundaries-")), root = join(directory, "durable"), run = join(directory, "run");
  await mkdir(root, { mode: 0o700 }); await mkdir(run, { mode: 0o700 });
  await writeFile(join(root, "config.json"), JSON.stringify(defaultConfig()), { mode: 0o600 });
  const store = openMonitorStore(root), epoch = randomUUID();
  await store.initialize(); await store.begin(epoch, Date.now(), [AGENT]);
  return { directory, root, run, store, epoch, close: () => rm(directory, { recursive: true, force: true }) };
}

test("executor result acceptance requires a released tool identity, ignores imported history and does not claim execution", async () => {
  const events: Array<{ stepId: string; toolCallId: string }> = [];
  const session: PromptSession = { stream: () => ({ fullStream: { async *[Symbol.asyncIterator]() {} },
    usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    response: Promise.resolve({ modelId: STUB_ECHO_MODEL_ID, finishReason: "tool-calls", messages: [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-one", toolName: "owned", args: {} }] },
    ] }),
  }) };
  const history = { role: "tool", content: [{ type: "tool-result", toolCallId: "call-one", toolName: "owned", result: "PRIVATE_TOOL_OUTPUT" }] };
  const host = asHostPromptSession(session, STUB_ECHO_MODEL_ID, undefined, { requireStepId: true, onToolResultAccepted: event => { events.push(event); } });
  const imported = host.getExecutor([history]);
  imported.appendMessages([history]); expect(events).toEqual([]);
  const executor = host.getExecutor();
  const response = await executor.stream({}, "step-one").response;
  executor.appendMessages(response.messages);
  executor.appendMessages([history]); expect(events).toEqual([{ stepId: "step-one", toolCallId: "call-one" }]);
  executor.appendMessages([history]); expect(events).toHaveLength(1);
  const ambiguous = host.getExecutor();
  await ambiguous.stream({}, "step-two").response;
  await ambiguous.stream({}, "step-three").response;
  ambiguous.appendMessages([history]); expect(events).toHaveLength(1);
  executor.clearMessages();
  executor.appendMessages([history]); expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_TOOL_OUTPUT");
});

test("source-owned task health includes queued/approval phases, is bounded, and never mistakes dropped coverage for idle", async () => {
  let now = Date.now(); const runEvents: RunObservation[] = [], tools: NativeToolObservation[] = [];
  const observer = createRunObserver({ generation: GEN, instrumented: true, now: () => now, emit: e => runEvents.push(e), emitTool: e => tools.push(e) });
  const entered = gate(), done = gate(); let tool: ReturnType<typeof observer.tool>;
  const task = observer.queue(AGENT, async () => {
    observer.progress("model"); tool = observer.tool("turn-one", "step-one", "call-one"); entered.release(); await done.promise; return "native-result";
  }, { source: "turn" });
  const queued = observer.snapshot([AGENT])!; expect(queued.tasks[0]!.state).toBe("queued");
  const running = task.task(); await entered.promise; now += 301000;
  expect(projectNativeRunHealth(observer.snapshot([AGENT]))!.tasks[0]!.phase).toBe("tool_or_approval");
  tool!.finish(true); tool!.finish(false);
  expect(tools.map(e => e.state)).toEqual(["native_started", "returned"]);
  expect(tools[0]).toMatchObject({ nativeHandlerObserved: true, externalCommitObserved: false, dispatchId: runEvents[0]!.dispatchId });
  done.release(); expect(await running).toBe("native-result"); expect(observer.snapshot([AGENT])!.tasks).toEqual([]);
  const queuedTasks = Array.from({ length: 257 }, () => observer.queue(AGENT, () => undefined, {}));
  expect(observer.snapshot([AGENT])).toMatchObject({ coverage: "partial", droppedTasks: 1 });
  expect(observer.snapshot([AGENT])!.tasks).toHaveLength(256);
  for (const task of queuedTasks) (task.options as { onCancelled(): void }).onCancelled();
  expect(observer.snapshot([AGENT])!.coverage).toBe("partial");
});

test("parallel tool handlers keep the task in approval/tool phase until the last handler settles", async () => {
  const observer = createRunObserver({ generation: GEN, instrumented: true, emit: () => undefined });
  const task = observer.queue(AGENT, async () => {
    const first = observer.tool("turn-one", "step-one", "first")!, second = observer.tool("turn-one", "step-one", "second")!;
    first.finish(true); observer.progress("model");
    expect(observer.snapshot([AGENT])!.tasks[0]!.phase).toBe("tool_or_approval");
    first.finish(false); expect(observer.snapshot([AGENT])!.tasks[0]!.phase).toBe("tool_or_approval");
    second.finish(false); expect(observer.snapshot([AGENT])!.tasks[0]!.phase).toBe("native");
  }, { source: "turn" });
  await task.task(); expect(observer.snapshot([AGENT])!.tasks).toEqual([]);
});

test("artifact and tool evidence from different executions cannot manufacture one complete causal chain", () => {
  const at = new Date().toISOString();
  const facts: EvidenceFact[] = [
    { ref: "host", value: { name: "host_seam_stage", stage: "hook_enter", ...identity, at, build, wireVersion: 8,
      sourceIdentity: { sourceSha256: "1".repeat(64), profileSha256: "2".repeat(64), transformedSha256: GEN } } },
    { ref: "modeld", value: { name: "model_step_terminal", ...identity, turnId: "other-turn", at, build, wireVersion: 8 } },
    { ref: "handler", value: { name: "host_tool_observation", ...identity, state: "returned", basis: "native_tool_handler", toolCallId: "call-one" } },
    { ref: "result", value: { name: "host_tool_observation", ...identity, state: "result_accepted", basis: "prompt_executor_append", toolCallId: "call-other" } },
  ];
  const coverage = assessEvidenceCoverage(facts);
  expect(coverage.find(c => c.requirement === "E02")!.missing).toContain("host_modeld_identity_build_or_wire_mismatch");
  expect(coverage.find(c => c.requirement === "E04")!.missing).toContain("tool_identity_correlation");
});

test("stall detection consumes the exact active source window, skips approval/absent/stale and keeps its witness", async () => {
  const f = await fixture();
  try {
    let now = Date.now() - 400000;
    const events: RunObservation[] = [];
    const observer = createRunObserver({ generation: GEN, instrumented: true, now: () => now, emit: e => events.push(e) });
    const entered = gate(), done = gate();
    const task = observer.queue(AGENT, async () => { observer.progress("model"); entered.release(); await done.promise; }, { source: "turn" });
    const running = task.task(); await entered.promise;
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: "d".repeat(64), expectedCursor: null, nextCursor: "first", events, atMs: now, notifications: "off" });
    now += 301000;
    const healthy = observer.snapshot([AGENT])!;
    for (const nativeRuns of [
      { ...healthy, coverage: "partial" as const }, { ...healthy, hostGenerationId: "wrong-generation" },
      { ...healthy, observedAtMs: now - 6000 }, { ...healthy, tasks: [] },
      { ...healthy, tasks: healthy.tasks.map(task => ({ ...task, phase: "tool_or_approval" as const })) },
    ]) expect((await f.store.detectUnsettled({ epoch: f.epoch, nowMs: now, sourceLiveness: new Map(), nativeRuns, notifications: "off" })).suspected).toBe(0);
    const result = await f.store.detectUnsettled({ epoch: f.epoch, nowMs: now, sourceLiveness: new Map(), nativeRuns: healthy, notifications: "off" });
    expect(result.suspected).toBe(1);
    expect((await f.store.detectUnsettled({ epoch: f.epoch, nowMs: now, sourceLiveness: new Map(), nativeRuns: healthy, notifications: "off" })).suspected).toBe(0);
    const incident = (await f.store.incidents()).find(i => i.rule === "execution_stalled")!;
    const evidence = await f.store.incidentEvidence(incident.id, 1);
    expect(evidence).toMatchObject({ state: "available", assessment: { category: "suspected_stall", rootCause: "not_proven" } });
    if (!("coverageByRequirement" in evidence)) throw Error("fixture_no_manifest");
    expect(evidence.coverageByRequirement.find(row => row.requirement === "E08")).toMatchObject({ status: "observed" });
    expect(evidence.facts.some(fact => "value" in fact && fact.value.name === "host_run_health")).toBe(true);
    expect(await f.store.notificationWork()).toEqual([]);
    done.release(); await running;
  } finally { await f.close(); }
});

test("real journal producer to SQLite closure retains artifact, tool and checkpoint facts without changing old revisions", async () => {
  const f = await fixture();
  try {
    const at = new Date().toISOString(), writer = (value: unknown) => appendHostJournal(f.run, value, { configurationRoot: f.root });
    await writer({ name: "host_seam_stage", schemaVersion: 1, at, stage: "hook_enter", result: "entered", ...identity, build, wireVersion: 8,
      sourceIdentity: { sourceSha256: "1".repeat(64), profileSha256: "2".repeat(64), transformedSha256: GEN } });
    await writer({ name: "host_tool_observation", schemaVersion: 1, at, ...identity, state: "returned", dispatchId: "dispatch-one", toolCallId: "tool-one",
      basis: "native_tool_handler", nativeHandlerObserved: true, externalCommitObserved: false, prompt: "PRIVATE_PROMPT" });
    await writer({ name: "host_tool_observation", schemaVersion: 1, at, ...identity, state: "result_accepted", toolCallId: "tool-one",
      basis: "prompt_executor_append", nativeHandlerObserved: false, externalCommitObserved: false, result: "PRIVATE_RESULT" });
    await writer({ name: "host_context_observation", schemaVersion: 1, at, ...identity, state: "checkpoint_observed", persisted: true,
      basis: "native_context_owner", operationId: "compact-one", rootId: "3".repeat(64), sourceRootRevision: "4".repeat(64), rootRevision: "5".repeat(64), summary: "PRIVATE_SUMMARY" });
    await writer({ name: "host_stream_rejected", schemaVersion: 2, at, ...identity, mode: "route", stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" });
    const batch = await readJournalBatch(f.run, null), atMs = Date.now();
    // Feed the existing typed modeld producer projection alongside the actual Host journal source.
    batch.events.unshift({ name: "model_step_terminal", schemaVersion: 3, at, ...identity, serviceEpoch: "modeld-one", outcome: "ok",
      phase: "complete", eventCount: 2, build, wireVersion: 8 });
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: "d".repeat(64), expectedCursor: null, nextCursor: batch.nextCursor!, events: batch.events, atMs,
      sourceHealth: { name: "observation_source_health", schemaVersion: 1, at: new Date(atMs).toISOString(), collectorEpoch: f.epoch,
        sourceKey: "d".repeat(64), source: "host", state: "observed", basis: "collector_read", producerLiveness: "not_checked", readBytes: batch.readBytes, records: batch.events.length, hasMore: false } });
    const incident = (await f.store.incidents()).find(i => i.rule === "execution_failure")!;
    const first = await f.store.incidentEvidence(incident.id, 1);
    if (!("coverageByRequirement" in first)) throw Error("fixture_missing_evidence");
    expect(first.coverageByRequirement.find(r => r.requirement === "E02")).toMatchObject({ status: "observed" });
    expect(first.coverageByRequirement.find(r => r.requirement === "E04")).toMatchObject({ status: "partial", missing: ["external_business_commit"] });
    expect(first.coverageByRequirement.find(r => r.requirement === "E05")).toMatchObject({ status: "observed" });
    expect(first.coverageByRequirement.find(r => r.requirement === "E08")).toMatchObject({ status: "partial", missing: ["producer_liveness_not_checked"] });
    const publicView = await f.store.incidentEvidence(incident.id, 1, "public-summary");
    expect(JSON.stringify(publicView)).not.toMatch(/PRIVATE_|aaaaaaaa-aaaa|bbbbbbbbbbbb|cccccccccccc/);
    expect(JSON.stringify(publicView)).toContain("native_tool_handler");
    expect(await f.store.incidentEvidence(incident.id, 1)).toEqual(first);
    expect(await readFile(join(f.run, "log/events.ndjson"), "utf8")).not.toMatch(/PRIVATE_/);
  } finally { await f.close(); }
});

test("invalid producer contracts, future arbitrary fields and coercion hooks cannot fabricate complete proof", () => {
  let called = 0;
  const hostile = { toString() { called++; return "returned"; } };
  expect(projectExecutionBoundary({ ...identity, name: "host_tool_observation", schemaVersion: 1, at: new Date().toISOString(), state: hostile })).toBeNull();
  expect(called).toBe(0);
  const facts: EvidenceFact[] = [{ ref: "fake", value: { ...identity, name: "host_context_observation", state: "checkpoint_observed", persisted: false,
    artifacts: { hostBuild: "fake", modeldBuild: "fake", wireVersion: 8 } } }];
  const rows = assessEvidenceCoverage(facts);
  expect(rows.find(r => r.requirement === "E02")!.status).not.toBe("observed");
  expect(rows.find(r => r.requirement === "E05")!.status).not.toBe("observed");
});
