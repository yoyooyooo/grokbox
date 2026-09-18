import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { runMonitor } from "../src/internal/roots/monitor.runtime.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const lifecycle = (n: number) => ({ name: "host_alert_observation", schemaVersion: 1, kind: "observer_started", eventId: `event-${n}`, sourceInstanceId: "synthetic-source", sourceSequence: n, hostGenerationId: "host-a", at: "2026-09-16T00:00:00.000Z", observedAt: "2026-09-16T00:00:00.000Z" });

test("a pending ownership RPC cannot delay a local failure or keep writing after collector cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-slow-source-")), run = join(root, "run"), controller = new AbortController();
  const store = openMonitorStore(root);
  await mkdir(join(run, "log"), { recursive: true }); await store.initialize();
  const event = { name: "host_run_observation", at: new Date().toISOString(), hostGenerationId: "host-a", agentId: AGENT, dispatchId: "slow-source-dispatch", state: "failed", source: "turn" };
  await writeFile(join(run, "log/events.ndjson"), JSON.stringify(event) + "\n");
  let reads = 0, sourceAborted = false, noticed = false, timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 4000);
  try {
    await runMonitor({ durableRoot: root, runRoot: run, agentIds: [AGENT], signal: controller.signal,
      read: async (_ids, signal) => {
        reads++;
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => { sourceAborted = true; reject(new Error("synthetic-source-cancelled")); };
          if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
        });
      },
      publish: receipt => {
        if (receipt.changes.some(change => change.kind === "execution_failure_observed")) {
          noticed = true; expect(receipt.state).toBe("unavailable"); controller.abort();
        }
      },
    });
    expect(timedOut).toBe(false); expect(noticed).toBe(true); expect(reads).toBe(1); expect(sourceAborted).toBe(true);
    expect((await store.snapshot()).collectorRecordedRunning).toBe(false);
    expect((await store.incidents()).some(row => row.rule === "native_run_failure")).toBe(true);
    expect((await store.notificationWork())[0]?.state).toBe("ready");
  } finally { clearTimeout(deadline); controller.abort(); await rm(root, { recursive: true, force: true }); }
}, 6000);

for (const scenario of ["initial-backlog", "late-local-event"] as const) {
  test(`local journal ${scenario} does not accelerate authenticated ownership sampling`, async () => {
    const root = await mkdtemp(join(tmpdir(), "monitor-cadence-review-")), run = join(root, "run");
    const path = join(run, "log/events.ndjson"), controller = new AbortController();
    await mkdir(join(run, "log"), { recursive: true });
    await openMonitorStore(root).initialize();
    await writeFile(path, scenario === "initial-backlog" ? Array.from({ length: 6000 }, (_, i) => JSON.stringify(lifecycle(i)) + "\n").join("") : "");
    let ownershipReads = 0, publications = 0, indexed = 0, failed: unknown;
    let appended: Promise<void> | undefined;
    const timeout = setTimeout(() => { failed = new Error("synthetic monitor did not consume local evidence"); controller.abort(); }, 12_000);
    try {
      await runMonitor({ durableRoot: root, runRoot: run, agentIds: [AGENT], intervalMs: 30_000, signal: controller.signal,
        read: async () => {
          ownershipReads++;
          return { snapshot: ownedOwnershipSnapshot([AGENT]), gateway: { pid: 4242, startedAt: 1700000000000 } };
        },
        publish: receipt => {
          publications++; indexed += receipt.journal?.inserted ?? 0;
          if (scenario === "late-local-event" && publications === 1) {
            appended = appendFile(path, JSON.stringify(lifecycle(0)) + "\n");
          }
          if (scenario === "initial-backlog" ? indexed >= 6000 : indexed >= 1) controller.abort();
        },
      });
      await appended;
      expect(failed).toBeUndefined();
      expect(ownershipReads).toBe(1);
      expect(indexed).toBe(scenario === "initial-backlog" ? 6000 : 1);
      expect((await openMonitorStore(root).snapshot()).collectorRecordedRunning).toBe(false);
    } finally { clearTimeout(timeout); controller.abort(); await appended; await rm(root, { recursive: true, force: true }); }
  }, 15_000);
}
