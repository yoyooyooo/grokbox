import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { contextSnapshotBody, NORMALIZE_CAUSES, projectStreamDiagnostic } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { readJournalWindow, JOURNAL_READ_MAX_LINES } from "../src/internal/io/journal-reader.node.ts";
import { observeEvents, compactEvents, selectRetainedEventLines } from "../src/internal/io/journal.node.ts";
import { writeModeldStepOutcome } from "../src/internal/io/modeld-outcome.node.ts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { journalWriterHealth, observeJournalHealth, observeJournalWrite, noteJournalObservationTimeout } from "../src/internal/host/journal-health.node.ts";
import { withTransportOutcome } from "../src/internal/modeld/step-outcome.ts";
import { projectSendOutcome } from "../../cli/src/outcome.ts";

const at = new Date().toISOString();
const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const identity = { agentId: "owned-agent", turnId: "owned-turn", hostGenerationId: "host-1", serviceEpoch: "epoch-1" };
const seed = { name: "host_seam_stage", schemaVersion: 1, at, ...identity, stage: "stream_enter", result: "entered", stepId: "first", clientNonce: nonce };
const failure = { name: "model_step_terminal", schemaVersion: 3, at, ...identity, stepId: "failed", outcome: "error", phase: "normalize", failureCode: "stream_invalid", eventCount: 1429, diagnostic: { phase: "normalize", reason: "stream_shape", normalizeCause: "missing_finish", rejectSite: "sdk_finish" } };
const reject = { name: "host_stream_rejected", schemaVersion: 2, at, ...identity, mode: "route", stepId: "failed", errorCode: "invalid_stream", stage: "normalize", reason: "invalid-stream" };
const progress = { id: "t0s0", kind: "send-message", requestId: "first", message: { type: "text", content: "working" } };
const user = { id: "t0u", kind: "message", role: "user", clientNonce: nonce, requestId: "first" };
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
async function root() { const dir = await mkdtemp(join(tmpdir(), "owned-observation-")); await mkdir(join(dir, "log")); return dir; }
const path = (root: string) => join(root, "log", "events.ndjson");

const flood = () => Array.from({ length: 7000 }, (_, i) => ({ name: "host_seam_stage", schemaVersion: 1, at, agentId: "other-agent", turnId: `other-${i}`, stepId: `step-${i}`, hostGenerationId: "h".repeat(64), stage: "first_chunk", result: "ok" }));

describe("bounded journal evidence survives a busy multi-Bot runtime", () => {
  test("file larger than 1MiB stays readable; filter target before event cap", async () => {
    const dir = await root();
    try {
      const body = [seed, failure, reject, ...flood()].map(line).join("");
      expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);
      await writeFile(path(dir), body);
      const observed = await observeEvents(dir, 4096, { agentId: identity.agentId, nonce });
      expect(observed.state).toBe("present"); expect(observed.events).toHaveLength(3); expect(observed.truncated).toBe(false);
      const outcome = projectSendOutcome({ agentId: identity.agentId, nonce, entries: [user, progress], alerts: [], truncated: false, runtimeEvents: observed.events });
      expect(outcome.state).toBe("failed"); expect(outcome.delivery).toHaveLength(1);
      expect(outcome.runtimeFailure).toMatchObject({ stepId: "failed", diagnostic: { normalizeCause: "missing_finish" } });
      expect(await readFile(path(dir), "utf8")).toBe(body);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("compaction keeps failed TURN association and makes discarded history visible", async () => {
    const dir = await root();
    try {
      await writeFile(path(dir), [seed, failure, reject, ...flood()].map(line).join(""));
      await compactEvents(dir);
      const contents = await readFile(path(dir), "utf8");
      expect(contents).toContain('"stepId":"failed"'); expect(contents).toContain(nonce);
      const first = JSON.parse(contents.split("\n")[0]!);
      expect(first).toMatchObject({ name: "journal_retention", schemaVersion: 1 });
      expect(first.discardedRecordsLowerBound).toBeGreaterThan(0);
      const observed = await observeEvents(dir, 4096, { agentId: identity.agentId, stepId: "failed" });
      expect(observed.window?.retention?.applied).toBe(true);
      expect(observed.events.some(e => "stepId" in e && e.stepId === "failed")).toBe(true);
      await compactEvents(dir);
      expect((await observeEvents(dir, 4096, { agentId: identity.agentId, nonce })).events).toHaveLength(3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("retention honors the time horizon instead of implying indefinite evidence", () => {
    const now = Date.now(), old = new Date(now - 8 * 24 * 60 * 60_000).toISOString();
    const kept = selectRetainedEventLines([line({ ...failure, at: old }), ...flood().map(line)], now);
    expect(kept.some(l => l.includes('"stepId":"failed"'))).toBe(false);
  });
  test("partial tail is disclosed without discarding previous complete failure", async () => {
    const dir = await root(); try {
      await writeFile(path(dir), line(failure) + '{"incomplete":');
      const observed = await observeEvents(dir);
      expect(observed.state).toBe("partial"); expect(observed.events).toHaveLength(1);
      expect(observed.window?.trailingPartial).toBe(true);
      expect((await readFile(path(dir), "utf8")).endsWith('{"incomplete":')).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("invalid UTF8 in one line does not erase the following valid evidence", async () => {
    const dir = await root(); try {
      await writeFile(path(dir), Buffer.concat([Buffer.from([0xff, 10]), Buffer.from(line(failure))]));
      const observed = await observeEvents(dir);
      expect(observed.state).toBe("partial"); expect(observed.events).toHaveLength(1);
      expect(observed.window?.malformedLines).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("suffix boundaries drop partial prefix and never fabricate an event", async () => {
    const dir = await root(); try {
      await writeFile(path(dir), line(seed) + line(failure));
      const read = await readJournalWindow(path(dir), Buffer.byteLength(line(failure)) + 10);
      expect(read.lines).toEqual([JSON.stringify(failure)]);
      expect(read.window.prefixOmitted).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("tiny-line flood bounds line objects as well as byte buffers", async () => {
    const dir = await root(); try {
      await writeFile(path(dir), "{}\n".repeat(JOURNAL_READ_MAX_LINES + 50));
      const read = await readJournalWindow(path(dir));
      expect(read.lines.length).toBeLessThanOrEqual(JOURNAL_READ_MAX_LINES);
      expect(read.window.linesOmitted).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("symlink and unreadable journal do not become a clean empty window", async () => {
    const dir = await root(); try {
      await writeFile(join(dir, "private"), line(seed)); await symlink(join(dir, "private"), path(dir));
      expect((await readJournalWindow(path(dir))).state).toBe("invalid");
      await rm(path(dir)); await writeFile(path(dir), line(seed), { mode: 0o000 });
      expect((await readJournalWindow(path(dir))).state).toBe("unavailable");
      await chmod(path(dir), 0o600);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("observation failures are visible without becoming execution authority", () => {
  test("writer failure, projection rejection and observer timeout are separately counted", async () => {
    const dir = await root(); try {
      await observeJournalWrite(dir, async () => { throw Error("RAW_SECRET_NOT_LOGGED"); });
      await appendHostJournal(dir, { name: "unknown", raw: "RAW_SECRET_NOT_LOGGED" });
      noteJournalObservationTimeout(dir);
      await observeJournalWrite(dir, async () => "written");
      expect(journalWriterHealth(dir)).toMatchObject({ writeFailed: 1, unprojected: 1, timedOut: 1, written: 1, pending: 0 });
      const health = await observeJournalHealth(dir);
      expect(health.liveness).toBe("not_proven"); expect(health.writers.length).toBe(1);
      expect(JSON.stringify(health)).not.toContain("RAW_SECRET_NOT_LOGGED");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("an explicit error is not replaced by subsequent disconnect cleanup", () => {
    const outcome = withTransportOutcome({ outcome: "unknown", phase: "provider", eventCount: 2, bindingId: "b" }, { outcome: "error", phase: "normalize", failureCode: "stream_invalid", eventCount: 2 }, true);
    expect(outcome).toMatchObject({ outcome: "error", phase: "normalize", failureCode: "stream_invalid", cleanup: { clientDisconnected: true, cancellationRequested: true } });
  });
  test("transport-only cancellation is not relabeled as a provider error", () => {
    const outcome = withTransportOutcome({ outcome: "unknown", phase: "provider", eventCount: 2 }, { outcome: "cancelled", phase: "provider", failureCode: "cancelled", eventCount: 2 }, true);
    expect(outcome).toMatchObject({ outcome: "cancelled", phase: "transport", failureCode: "disconnected" });
  });
  for (const normalizeCause of NORMALIZE_CAUSES) {
    test(`modeld writer → safe projector → reader → outcome preserves ${normalizeCause}`, async () => {
      const dir = await root(); try {
        const body = contextSnapshotBody({ version: 1, profileId: "p", abiIdentity: "abi", systemMessages: [{ role: "system", content: "SECRET_PROMPT" }], messages: [], tools: [], options: {} });
        await Effect.runPromise(writeModeldStepOutcome(dir, {
          hostEpoch: { compile: "host-1", source: "source", profile: "p", hostIdentity: "h", bridgeDigest: "bridge", wireVersion: "v4" }, serviceEpoch: { incarnationId: "epoch-1" }, agentId: identity.agentId, turnId: identity.turnId, stepId: "failed",
          selection: { agentId: identity.agentId, modelId: "model", selectionRevision: "f".repeat(64) }, snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) },
        }, { outcome: "error", phase: "normalize", failureCode: "stream_invalid", eventCount: 2, diagnostic: { phase: "normalize", reason: "stream_shape", normalizeCause, rejectSite: "sdk_part" } }));
        const read = await observeEvents(dir, 4096, { agentId: identity.agentId, stepId: "failed" });
        const outcome = projectSendOutcome({ agentId: identity.agentId, stepId: "failed", entries: [], alerts: [], truncated: false, runtimeEvents: read.events });
        expect(outcome.state).toBe("failed"); expect(outcome.runtimeFailure?.diagnostic?.normalizeCause).toBe(normalizeCause);
        expect(await readFile(path(dir), "utf8")).not.toContain("SECRET_PROMPT");
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
});
