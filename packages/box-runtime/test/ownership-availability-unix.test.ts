import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OWNERSHIP_READ_SOURCE, failureSummaryOf, presentFailure } from "@grokbox/runtime-kernel/contract";
import { projectSendOutcome } from "../../cli/src/outcome.ts";
import { bindHostOwnershipRead } from "../src/internal/host/ownership-read.ts";
import type { OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";
import { providerRuntimeFixture, waitFixtureRows, syntheticTool, successfulProviderResponse } from "./provider-runtime-fixture.ts";

const input = [{ role: "system" as const, content: "Synthetic root" }, { role: "user" as const, content: "Synthetic request" }];

test("actual production root, native bridge, Unix and Host reuse a moderately slow source through tool finish", async () => {
  const native = bindHostOwnershipRead();
  let sourceCalls = 0, modelCalls = 0;
  const invoke = async (ids: string[], localOnly = false) => ({ gateway: { pid: process.pid, startedAt: 1 },
    snapshot: await native({ agentIds: ids, localOnly,
      readScope: () => ({ backend: "https://fixture.invalid", account: "a".repeat(64), team: null, machine: "synthetic" }),
      readWindow: () => ({ kind: "inactive" }), readExecution: () => ({ allowed: true, bound: true }),
      readLocal: () => ({ harness: "box", serverId: "server" }),
      listServer: async signal => {
        sourceCalls++;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(Error("fixture cancelled")); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2500);
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
        return { agents: ids.map(agentId => ({ agentId, id: "server", harness: "box" })) };
      } }) });
  const source: OwnershipReader = ids => invoke(ids);
  source.local = ids => invoke(ids, true);
  const fetch = Object.assign(async () => { modelCalls++; return successfulProviderResponse(); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { ownershipRead: source });
  try {
    const stepId = randomUUID();
    const response = await f.session.getExecutor(input).stream({}, stepId, [syntheticTool]).response;
    expect(response.finishReason).toBe("tool-calls"); expect(sourceCalls).toBe(1); expect(modelCalls).toBe(1);
    const rows = await waitFixtureRows(f, stepId);
    const terminals = rows.filter(row => row.name === "model_step_terminal" && row.stepId === stepId);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ outcome: "ok", backendAttempts: 1, authority: {
      policyId: "strict-observation-v2", phase: "authorized", checkpoint: "finish",
      diagnostic: { ownershipWait: { evidenceUse: "step" } },
    } });
    expect(rows.find(row => row.name === "host_normalized_terminal" && row.stepId === stepId)?.toolCallCount).toBe(1);
    expect(rows.some(row => row.name === "host_stream_rejected" && row.stepId === stepId)).toBe(false);
  } finally { await f.stop(); }
}, 12000);

test("over-age cause survives real root, Unix, Host, journal, SQLite cold read and CLI without ownership or replay claims", async () => {
  let sourceCalls = 0, modelCalls = 0;
  const secret = "PRIVATE_AVAILABILITY_SENTINEL";
  // Synthetic source supplies a genuinely old observation. This test exercises
  // transport/projection, not real upstream latency or a Server snapshot SLA.
  const source: OwnershipReader = async ids => {
    sourceCalls++;
    const now = Date.now(), snapshot = ownedOwnershipSnapshot(ids, { nowMs: now - 5500 });
    return { gateway: { pid: process.pid, startedAt: 1 }, snapshot: { ...snapshot, completedAt: new Date(now).toISOString(),
      readObservation: { version: 1, source: OWNERSHIP_READ_SOURCE, state: "observed", phase: "complete", serverRead: "request",
        durationMs: 5500, serverWaitMs: 5500, serverEvidenceAgeMs: 5500, private: secret } } };
  };
  const fetch = Object.assign(async () => { modelCalls++; return successfulProviderResponse(); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const f = await providerRuntimeFixture(fetch, { ownershipRead: source });
  const monitorRoot = join(f.durableRoot, "observations"), monitor = openMonitorStore(monitorRoot), epoch = randomUUID();
  let initialized = false;
  try {
    const stepId = randomUUID();
    const error = await f.session.getExecutor(input).stream({}, stepId, [syntheticTool]).response.catch(error => error);
    const summary = failureSummaryOf(error)!;
    expect(modelCalls).toBe(0); expect(sourceCalls).toBe(2);
    expect(summary?.diagnostic?.authority).toMatchObject({ reason: "ownership_evidence_stale", availabilityCause: "read_elapsed",
      evidenceAgeMs: 5500, readRecovery: { attempts: 2, firstReadReason: "ownership_evidence_stale" } });
    expect(presentFailure(summary).message).toContain("does not establish that ownership changed");
    const rows = await waitFixtureRows(f, stepId);
    expect(rows.filter(row => row.name === "model_step_terminal" && row.stepId === stepId)).toHaveLength(1);
    await monitor.initialize(); await monitor.begin(epoch, Date.now(), [f.agentId]); initialized = true;
    await monitor.ingestEvidence({ epoch, sourceKey: "b".repeat(64), expectedCursor: null, nextCursor: "one", events: rows, atMs: Date.now() });
    const bytes = await readFile(monitor.path);
    const cold = openMonitorStore(monitorRoot);
    const retained = await cold.executionEvidence({ agentId: f.agentId, stepId });
    const outcome = projectSendOutcome({ agentId: f.agentId, stepId, entries: [], alerts: [], truncated: false, runtimeEvents: retained.events });
    expect(outcome.state).toBe("failed");
    expect(outcome.runtimeAuthority).toMatchObject({ currentLiveness: "not_proven", replayAuthorized: false,
      state: { policyId: "strict-observation-v2", phase: "denied", diagnostic: { availabilityCause: "read_elapsed" } } });
    expect(await readFile(monitor.path)).toEqual(bytes);
    expect(JSON.stringify(retained)).not.toContain(secret); expect(bytes.includes(Buffer.from(secret))).toBe(false);
  } finally { if (initialized) await monitor.finish(epoch, Date.now()); await f.stop(); }
}, 12000);
