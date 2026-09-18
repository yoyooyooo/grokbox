import { isAbsolute, basename } from "node:path";
import { withEventsLock, appendNdjsonLine } from "../../src/internal/host/terminal-journal.node.ts";

const root = process.argv[2];
if (!root || !isAbsolute(root) || !basename(root).startsWith("journal-lock-test-")) throw new Error("owned_test_root_required");
const stage = process.argv[3];
if (stage !== undefined && stage !== "queued") {
  if (!["intent", "renamed", "created", "committed"].includes(stage)) throw new Error("owned_test_stage_required");
  await appendNdjsonLine(root, JSON.stringify({ name: "fixture", value: 999, padding: "x".repeat(700) }), "host", {
    policy: { segmentBytes: 2048, maxBytes: 8192 },
    afterStage: reached => { if (reached === stage) process.kill(process.pid, "SIGKILL"); },
  });
  process.exitCode = 3; // The requested crash boundary must actually be reached.
} else {
  // Parent begins observing preparation only after this child finished module
  // loading. Startup latency is not evidence of the lock protocol's behavior.
  if (stage === "queued") process.stdout.write('{"started":true}\n');
  await withEventsLock(root, async () => {
    process.stdout.write('{"locked":true}\n');
    // Only a disposable test process intentionally holds the writer boundary.
    await new Promise<void>(() => { setInterval(() => undefined, 1000); });
  });
}
