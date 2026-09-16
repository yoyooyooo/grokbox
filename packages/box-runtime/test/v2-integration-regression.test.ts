import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { WIRE_VERSION, contextSnapshotBody, projectFailureSummary, presentFailure, projectRuntimeBuildInfo, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { streamModeld } from "../src/internal/host/modeld-client.node.ts";
import { encodeModeldFrame } from "../src/internal/wire/modeld-wire.ts";
import { writeModeldStepOutcome, projectModeldStepOutcome } from "../src/internal/io/modeld-outcome.node.ts";
import { currentJournalWriterHealth, observeJournalWrite, observeJournalHealth, journalWriterHealth } from "../src/internal/host/journal-health.node.ts";
import { observeEvents } from "../src/internal/io/journal.node.ts";
import { createAlertObserver } from "../src/internal/host/alert-observation.ts";
import { traceAlerts } from "@grokbox/runtime-kernel/alerts";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function request(): RunStepRequest {
  const body = contextSnapshotBody({ version: 1, profileId: "t21-independent-root", abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "synthetic root" }], messages: [{ role: "user", content: "synthetic request" }], tools: [], options: {} });
  return { agentId: "agent-a", turnId: "turn-a", stepId: "step-a", hostEpoch: { compile: "host-a", profile: "profile-a", source: "source-a", hostIdentity: "identity-a", bridgeDigest: "bridge-a", wireVersion: `v${WIRE_VERSION}` },
    serviceEpoch: { incarnationId: randomUUID() }, selection: { agentId: "agent-a", modelId: "stub/echo", selectionRevision: "a".repeat(64) },
    snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) } };
}

test("the unified modeld writer records each append once under its actual role", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-role-count-"));
  try {
    await Effect.runPromise(writeModeldStepOutcome(root, request(), { outcome: "error", phase: "provider", eventCount: 0, failureCode: "provider_error" }));
    expect(currentJournalWriterHealth(root, "modeld")).toMatchObject({ attempted: 1, written: 1, pending: 0 });
    expect(currentJournalWriterHealth(root, "host")).toMatchObject({ attempted: 0, written: 0 });
    expect((await readFile(join(root, "log/events.ndjson"), "utf8")).trim().split("\n")).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attempt summary truncation never masquerades as a complete execution history", () => {
  const projected = projectModeldStepOutcome({ name: "model_step_terminal", schemaVersion: 3,
    at: new Date().toISOString(), agentId: "a", turnId: "t", stepId: "s", hostGenerationId: "h", serviceEpoch: "e",
    outcome: "error", phase: "provider", failureCode: "provider_error", eventCount: 0, backendAttempts: 6,
    attempts: Array.from({ length: 4 }, (_, index) => ({ index, failureCode: "provider_error" })),
  });
  expect(projected?.backendAttempts).toBe(6);
  expect(projected?.attempts).toHaveLength(4);
  expect(projected?.attemptsTruncated).toBe(true);
});

test("observation backlog drops are measured, not reported as zero or successful writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-observer-backlog-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: Promise<unknown>[] = [];
  try {
    for (let n = 0; n < 64; n++) writes.push(observeJournalWrite(root, async () => { await gate; return "written"; }));
    let executed = false;
    expect(await observeJournalWrite(root, async () => { executed = true; return "written"; })).toBe("write_failed");
    expect(executed).toBe(false);
    expect(journalWriterHealth(root)).toMatchObject({ dropped: 1, pending: 64, written: 0 });
    release(); await Promise.all(writes);
    expect(journalWriterHealth(root)).toMatchObject({ attempted: 65, dropped: 1, pending: 0, written: 64 });
  } finally { release(); await Promise.all(writes); await rm(root, { recursive: true, force: true }); }
});

test("already shipped health snapshots remain read-only evidence with an unknown role", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-legacy-health-")), id = randomUUID(), at = new Date().toISOString();
  const directory = join(root, "state/observability"), path = join(directory, `${id}.json`);
  try {
    await mkdir(directory, { recursive: true });
    const original = JSON.stringify({ version: 1, observerId: id, pid: process.pid, observedAt: at,
      attempted: 8, written: 4, unprojected: 1, writeFailed: 1, timedOut: 1, dropped: 2,
      pending: 0, peakPending: 2, lastSuccessAt: at, lastFailureAt: at });
    await writeFile(path, original);
    const observed = await observeJournalHealth(root);
    expect(observed).toMatchObject({ state: "present", liveness: "not_proven" });
    expect(observed.writers[0]).toMatchObject({ role: "legacy", failed: 1, timedOut: 1, dropped: 2 });
    expect(observed.writers[0]?.healthWriteFailures).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(lstat(join(root, "state/journal-health"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("request lookup preserves the same-Host observer even when no Tray exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-no-tray-")), events: unknown[] = [];
  try {
    createAlertObserver({ generation: "host-a", observerRole: "host_target", emit: event => { events.push(event); } });
    events.push({ name: "host_stream_rejected", schemaVersion: 2, at: new Date().toISOString(), mode: "route",
      agentId: "agent-a", turnId: "turn-a", stepId: "step-a", hostGenerationId: "host-a",
      stage: "provider", errorCode: "model_error", reason: "terminal-rejected" });
    await mkdir(join(root, "log")); await writeFile(join(root, "log/events.ndjson"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
    const observed = await observeEvents(root, 100, { agentId: "agent-a", stepId: "step-a" });
    const trace = traceAlerts(observed.events, { agentId: "agent-a", stepId: "step-a" });
    expect(trace.instrumentation).toHaveLength(1);
    expect(trace.instrumentation[0]?.managerAttached).toBe("not_observed");
    expect(trace.traces.flatMap(t => t.decisions)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy retention markers still disclose missing evidence without a new receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-old-retention-")), at = new Date().toISOString();
  try {
    await mkdir(join(root, "log"));
    const rows = [
      { name: "journal_retention", schemaVersion: 1, discardedRecordsLowerBound: 10, discardedPrefix: true, latestDiscardedAt: at },
      { name: "host_seam_stage", schemaVersion: 1, at, stage: "stream_enter", result: "entered", agentId: "agent-a", turnId: "turn-a", stepId: "step-a", hostGenerationId: "host-a" },
    ];
    await writeFile(join(root, "log/events.ndjson"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    expect((await observeEvents(root, 100, { agentId: "agent-a", stepId: "step-a" })).truncated).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local IPC failure cannot be relabelled by unrelated upstream HTTP metadata", () => {
  const summary = projectFailureSummary({ version: 1, code: "transport_error", phase: "transport", http: { status: 502 } })!;
  expect(summary).toMatchObject({ origin: "runtime", category: "local_transport" });
  expect(presentFailure(summary).message).toContain("local Host");
});

test("build provenance is a pure data projection and never invokes accessors", () => {
  let called = 0;
  expect(projectRuntimeBuildInfo({ version: 1, get kind() { called++; throw Error("private"); } })).toBeUndefined();
  expect(called).toBe(0);
});

test("a stalled Host reader backpressures the socket instead of draining arbitrary frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-reader-demand-"));
  const sockets = new Set<Socket>();
  let begin!: () => void, produced = 0;
  const ready = new Promise<void>(resolve => { begin = resolve; });
  const total = 16_384;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => undefined); socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => {
      socket.write(encodeModeldFrame({ ok: true, method: "run-step", kind: "accepted", version: WIRE_VERSION, bindingId: "binding-a" }));
      void ready.then(() => {
        const pump = () => {
          while (!socket.destroyed && produced < total) {
            const frame = encodeModeldFrame({ kind: "event", sequence: produced, event: { type: "text_delta", text: "x".repeat(4096) } });
            produced++;
            if (!socket.write(frame)) { socket.once("drain", pump); return; }
          }
        };
        pump();
      });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(root, "modeld.sock"), resolve); });
  const iterator = streamModeld(root, { method: "run-step", version: WIRE_VERSION }, { timeoutMs: 2000 })[Symbol.asyncIterator]();
  try {
    expect((await iterator.next()).value.kind).toBe("accepted");
    begin(); await pause(50);
    const stalledAt = produced;
    expect(stalledAt).toBeGreaterThan(0); expect(stalledAt).toBeLessThan(total);
    await pause(50); expect(produced).toBe(stalledAt);
  } finally {
    begin(); await iterator.return?.();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
