import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../../src/internal/io/monitor-store.node.ts";
const [root, phase] = process.argv.slice(2);
if (!root || !root.includes("monitor-crash-owned-") || !["before", "after", "held"].includes(phase)) throw Error("isolated_fixture_only");
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", epoch = randomUUID(), now = Date.now();
let armed = false;
const block = () => {
  process.stdout.write(JSON.stringify({ phase, epoch, pid: process.pid }) + "\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const store = openMonitorStore(root, {
  beforePublish: () => { if (armed && phase === "before") block(); },
  afterRename: () => { if (armed && phase === "after") block(); },
});
await store.initialize(); await store.begin(epoch, now, [AGENT]);
if (phase === "held") block();
armed = true;
await store.ingestEvidence({ epoch, sourceKey: "b".repeat(64), expectedCursor: null, nextCursor: "after-crash-record",
  atMs: now, events: [{ name: "host_stream_rejected", schemaVersion: 2, at: new Date(now).toISOString(), mode: "route",
    hostGenerationId: "c".repeat(64), agentId: AGENT, turnId: "turn-owned", stepId: "step-owned", stage: "normalize",
    reason: "invalid-stream", errorCode: "invalid_stream", failureId: "failure-owned" }] });
throw Error("fixture_should_be_stopped_by_its_test_owner");
