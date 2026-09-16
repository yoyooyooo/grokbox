import { Effect } from "effect";
import { openExecutionHistory } from "../../src/internal/io/execution-history.node.ts";

const root = process.argv[2];
if (!root) throw new Error("isolated storage root required");
let writes = 0;
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const history = yield* openExecutionHistory(root, "node-store-first");
  for (let i = 0; i < 4096; i++) {
    yield* history.putStep(`node-step-${i}`, { snapshotDigest: "a".repeat(64), selectionRevision: "b".repeat(64), bindingId: "c".repeat(64), status: "terminal" });
    writes++;
  }
  if (!(yield* history.getStep("node-step-0"))) throw new Error("earliest claim missing");
  if (!(yield* history.getStep("node-step-4095"))) throw new Error("latest claim missing");
})));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const history = yield* openExecutionHistory(root, "node-store-second");
  if ((yield* history.getStep("node-step-0")) !== undefined) throw new Error("old incarnation not retired");
  process.stdout.write(JSON.stringify({ runtime: process.version, writes, available: history.health().available, oldEpochRetired: true, networkCalls: 0 }));
})));
