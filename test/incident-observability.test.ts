import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeEvents, observeRuntimeEvents, compactEvents, selectRetainedEventLines, JOURNAL_RETENTION_MAX_BYTES } from "../packages/box-runtime/src/internal/io/journal.node.ts";
import { readJournalWindow } from "../packages/box-runtime/src/internal/io/journal-window.node.ts";
import { appendHostJournal, appendHostStreamRejected, withEventsLock } from "../packages/box-runtime/src/internal/host/terminal-journal.node.ts";
import { currentJournalWriterHealth, readJournalHealth } from "../packages/box-runtime/src/internal/host/journal-health.node.ts";
import { projectSendOutcome } from "../packages/cli/src/outcome.ts";
import { captureCli, parseJson, startMockGateway, writeDiscovery } from "./helpers.ts";

const AT = new Date().toISOString();
const NONCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "owned-agent";
const PRIVATE = "PRIVATE_LOG_BODY_OR_SECRET_SENTINEL";
const facts = { agentId: AGENT, turnId: "owned-turn", hostGenerationId: "owned-generation" };
const enter = { name: "host_seam_stage", schemaVersion: 1, at: AT, ...facts, clientNonce: NONCE, stage: "hook_enter", result: "entered" };
const start = { ...enter, stage: "stream_enter", stepId: "first-step" };
const first = { name: "host_normalized_terminal", at: AT, ...facts, stepId: "first-step", serviceEpoch: "owned-epoch", terminalClass: "stop", toolCallCount: 1 };
const last = { name: "host_stream_rejected", schemaVersion: 2, at: AT, mode: "route", ...facts, stepId: "failed-step", clientNonce: NONCE,
  serviceEpoch: "owned-epoch", stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream", requestKind: "main",
  diagnostic: { normalizeCause: "open_tools_at_finish", rejectSite: "canonical_finish", stream: { version: 1, counts: { openTools: 1, canonicalEvents: 1429 }, timings: {}, tail: [] } } };
const modelFailure = { name: "model_step_terminal", schemaVersion: 3, at: AT, ...facts, stepId: "failed-step", serviceEpoch: "owned-epoch",
  outcome: "error", phase: "normalize", failureCode: "stream_invalid", eventCount: 1429,
  diagnostic: { phase: "normalize", reason: "stream_shape", ...last.diagnostic } };
const origin = { kind: "message", role: "user", id: "t0u", clientNonce: NONCE, requestId: "first-step", content: "owned request" };
const progress = { kind: "send-message", id: "t0s0", requestId: "first-step", message: { type: "text", content: "Working" }, timestampMs: 1 };
const events = [enter, start, first, { ...start, stepId: "failed-step" }, modelFailure, last];
const noise = (count: number) => Array.from({ length: count }, (_, i) => ({ name: "host_seam_stage", schemaVersion: 1, at: AT,
  agentId: `sibling-${i % 10}`, turnId: `sibling-turn-${i}`, stage: "hook_enter", result: "entered", ignored: "x".repeat(300) }));
const ndjson = (rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
async function dir() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-incident-observation-"));
  await mkdir(join(root, "log"), { mode: 0o700 });
  return root;
}

describe("large journal and retention evidence", () => {
  test("a journal larger than 1MiB remains readable and exact request lookup crosses unrelated traffic", async () => {
    const root = await dir();
    try {
      await writeFile(join(root, "log/events.ndjson"), ndjson([...events, ...noise(9000)]));
      const before = await lstat(join(root, "log/events.ndjson"));
      const observed = await observeRuntimeEvents({ durableRoot: root, runRoot: root, source: "host", limit: 4096,
        lookup: { agentId: AGENT, clientNonce: NONCE } });
      expect(before.size).toBeGreaterThan(1024 * 1024);
      expect(observed.state).toBe("present");
      expect(observed.lookup).toMatchObject({ matched: true, anchored: true, turnIds: ["owned-turn"] });
      expect(observed.events).toHaveLength(events.length);
      expect(observed.truncated).toBe(false);
      expect(observed.events.at(-1)).toMatchObject({ stepId: "failed-step", diagnostic: { normalizeCause: "open_tools_at_finish" } });
      const tail = await observeEvents(root);
      expect(tail.state).toBe("present");
      expect(tail.truncated).toBe(true);
      expect(tail.coverage?.bytesRead).toBeLessThanOrEqual(1024 * 1024 + 1);
      expect((await lstat(join(root, "log/events.ndjson"))).mtimeMs).toBe(before.mtimeMs);
      expect(await readdir(join(root, "log"))).toEqual(["events.ndjson"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("UTF-8 cut prefix and pending final append are not treated as a corrupted whole file", async () => {
    const root = await dir(), path = join(root, "log/events.ndjson");
    try {
      const tail = ndjson([last]);
      const prefix = JSON.stringify({ x: "中文🙂".repeat(100) }) + "\n";
      await writeFile(path, prefix + tail + '{"unfinished":');
      const read = await readJournalWindow(path, Buffer.byteLength(tail) + 40);
      expect(read.state).toBe("present");
      expect(read.coverage).toMatchObject({ prefixOmitted: true, partialLastLine: true, invalidLines: 0 });
      expect(read.lines).toEqual([JSON.stringify(last)]);
      await expect(compactEvents(root)).rejects.toThrow("journal_compaction_unavailable");
      expect(await readFile(path, "utf8")).toBe(prefix + tail + '{"unfinished":');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("complete corrupt lines are partial evidence; symlinks and invalid budgets stay explicit", async () => {
    const root = await dir();
    try {
      const path = join(root, "log/events.ndjson");
      await writeFile(path, Buffer.concat([Buffer.from(ndjson(events)), Buffer.from([0xff, 10])]));
      const observed = await observeEvents(root, 4096, { agentId: AGENT, stepId: "failed-step" });
      expect(observed.state).toBe("partial");
      expect(observed.lookup?.matched).toBe(true);
      expect(observed.events.some(event => "name" in event && event.name === "host_stream_rejected")).toBe(true);
      expect((await readJournalWindow(path, -1)).failure).toBe("invalid_budget");
      const link = join(root, "symlink");
      await symlink(path, link);
      expect(await readJournalWindow(link)).toMatchObject({ state: "invalid", failure: "symlink_or_path" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("compaction preserves incident cores but exposes loss of surrounding evidence", async () => {
    const root = await dir();
    try {
      const second = events.map(event => ({ ...event, agentId: "another-agent", turnId: "another-turn", clientNonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
      const all = [...events, ...second, ...noise(1200)];
      const kept = selectRetainedEventLines(all.map(row => JSON.stringify(row)));
      expect(kept.filter(line => JSON.parse(line).name === "host_stream_rejected")).toHaveLength(2);
      expect(Buffer.byteLength(kept.join("\n"))).toBeLessThanOrEqual(JOURNAL_RETENTION_MAX_BYTES);
      await writeFile(join(root, "log/events.ndjson"), ndjson(all));
      await compactEvents(root);
      const result = await observeEvents(root, 4096, { agentId: AGENT, stepId: "failed-step" });
      expect(result.events.some(event => "stepId" in event && event.stepId === "failed-step")).toBe(true);
      expect(result.retention).toMatchObject({ state: "present", affectsWindow: true, value: { state: "applied" } });
      expect(result.truncated).toBe(true);
      // A later fully appended request is beyond the compacted prefix; it does
      // not inherit a false claim that *its* records were deleted by old retention.
      await appendHostJournal(root, { ...enter, turnId: "fresh-turn", clientNonce: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
      await appendHostStreamRejected(root, { ...last, turnId: "fresh-turn", stepId: "fresh-step", clientNonce: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
      const fresh = await observeEvents(root, 4096, { agentId: AGENT, stepId: "fresh-step" });
      expect(fresh.retention?.affectsWindow).toBe(false);
      expect(fresh.truncated).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("observation failures cannot silently erase evidence health", () => {
  test("failed journal append is visible outside the log directory and remains nonfatal", async () => {
    const root = await dir();
    try {
      expect(await appendHostStreamRejected(root, last)).toBe("written");
      await chmod(join(root, "log"), 0o500);
      expect(await appendHostStreamRejected(root, last)).toBe("write_failed");
      const health = await readJournalHealth(root);
      expect(health.state).toBe("present");
      expect(health.writers[0]).toMatchObject({ role: "host", written: 1, failed: 1, pending: 0 });
      expect(JSON.stringify(health)).not.toContain(PRIVATE);
    } finally { await chmod(join(root, "log"), 0o700); await rm(root, { recursive: true, force: true }); }
  });
  test("unprojected counter is flushed by a valid event, and broken health storage does not fail a valid append", async () => {
    const root = await dir();
    try {
      expect(await appendHostJournal(root, { name: PRIVATE })).toBe("unprojected");
      expect(await readdir(root)).toEqual(["log"]);
      await appendHostStreamRejected(root, last);
      expect((await readJournalHealth(root)).writers[0]?.unprojected).toBe(1);
      const other = await dir();
      try {
        await writeFile(join(other, "state"), "not a directory");
        expect(await appendHostStreamRejected(other, last)).toBe("written");
        expect(currentJournalWriterHealth(other, "host").healthWriteFailures).toBeGreaterThan(0);
        expect((await readJournalHealth(other)).state).toBe("unavailable");
      } finally { await rm(other, { recursive: true, force: true }); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("an EEXIST inside the protected callback is not permission to repeat its effects", async () => {
    const root = await dir();
    try {
      let effects = 0;
      await expect(withEventsLock(root, async () => { effects++; throw Object.assign(Error("owned"), { code: "EEXIST" }); })).rejects.toMatchObject({ code: "EEXIST" });
      expect(effects).toBe(1);
      expect((await readdir(join(root, "log"))).includes("events.lock")).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("delivery, failed execution and evidence quality stay separate", () => {
  const input = { agentId: AGENT, nonce: NONCE, entries: [origin, progress], alerts: [], truncated: false };
  test("an unread runtime does not turn a progress reply into a settled successful observation", () => {
    const result = projectSendOutcome({ ...input, runtimeEvents: [], runtimeGap: "invalid" });
    expect(result.state).toBe("unknown");
    expect(result.delivery).toHaveLength(1);
    expect(result.assessment).toMatchObject({ delivery: "observed", mainRun: "unknown", evidence: "incomplete" });
    expect(result.gaps).toContain("runtime_evidence_incomplete");
  });
  test("positive failure evidence wins even when another part of the window is missing", () => {
    const result = projectSendOutcome({ ...input, runtimeEvents: events, runtimeGap: "retained_subset" });
    expect(result).toMatchObject({ state: "failed", runtimeFailure: { stepId: "failed-step", diagnostic: { normalizeCause: "open_tools_at_finish" } },
      assessment: { delivery: "observed", mainRun: "failure_observed", evidence: "incomplete", hostToolMaterialsReleased: 1 } });
    expect(result.assessment.toolExecution).toBe("not_instrumented");
    expect(result.assessment.checkpointCommit).toBe("not_instrumented");
    expect(result.executionCompleted).toBe("not_proven");
  });
  test("a screenshot STEP joins only its explicit TURN and preserves the source exception", () => {
    const result = projectSendOutcome({ agentId: AGENT, stepId: "failed-step", entries: [origin, progress], alerts: [], truncated: false,
      runtimeEvents: [...events, { ...last, stepId: "unrelated-step", turnId: "next-turn", clientNonce: undefined }] });
    expect(result).toMatchObject({ state: "failed", clientNonce: NONCE, requestId: "first-step", requestedStepId: "failed-step" });
    expect(result.relatedTurnIds).toEqual(["owned-turn"]);
    expect(result.runtimeFailure?.diagnostic?.normalizeCause).toBe("open_tools_at_finish");
  });
  test("aux failure does not pretend the already observed delivery disappeared", () => {
    const result = projectSendOutcome({ ...input, runtimeEvents: [...events.slice(0, 3),
      { ...start, stepId: "memory-step", auxPurpose: "memory-extraction", parentStepId: "first-step" },
      { ...last, stepId: "memory-step", requestKind: "memory-extraction", parentStepId: "first-step" }] });
    expect(result.assessment).toMatchObject({ delivery: "observed", auxiliary: "failure_observed", mainRun: "completion_not_proven" });
    expect(result.runtimeFailure?.requestKind).toBe("memory-extraction");
  });
  test("the actual CLI looks up an old failed STEP behind a large amount of sibling traffic", async () => {
    const root = await dir(), config = await mkdtemp(join(tmpdir(), "grokbox-incident-cli-"));
    const gateway = await startMockGateway({ agents: [{ id: AGENT, name: "owned", isGroup: false, harness: "box" }], trays: [], tail: { entries: [origin, progress] } });
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const deps = { configDir: config, env: { GROKBOX_RUN_ROOT: root }, discoveryPath, transport: "local" as const,
      boxRuntimeRoot: join(config, "runtime"), daemonSocket: join(config, "none.sock"), stdinIsTTY: true,
      skillsDir: join(import.meta.dir, "../skills") };
    try {
      await writeFile(join(root, "log/events.ndjson"), ndjson([...events, ...noise(8000)]));
      const result = await captureCli(["history", "outcome", AGENT, "--step-id", "failed-step", "--runtime"], deps);
      expect(result.code).toBe(0);
      expect(parseJson(result.stdout)).toMatchObject({ data: { state: "failed", runtimeFailure: { stepId: "failed-step" },
        evidence: { runtimeGap: null, runtimeLookup: { matched: true, anchored: true } } } });
      expect(result.stdout).not.toContain(PRIVATE);
      const invalid = await captureCli(["history", "outcome", AGENT, "--step-id", "failed-step"], deps);
      expect(invalid.code).not.toBe(0);
      expect(gateway.requests.filter(request => request.pathname.startsWith("/api/")).every(request =>
        ["/api/listAgents", "/api/getAgentTranscriptTail", "/api/getTrays"].includes(request.pathname))).toBe(true);
    } finally { gateway.stop(); await rm(root, { recursive: true, force: true }); await rm(config, { recursive: true, force: true }); }
  });
});
