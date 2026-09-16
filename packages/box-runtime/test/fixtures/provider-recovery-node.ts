import assert from "node:assert/strict";
import { ClassicLevel } from "classic-level";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { Effect, Stream } from "effect";
import { openExecutionHistory } from "../../src/internal/io/execution-history.node.ts";
import { withProviderRecovery, type RecoveryProgress } from "../../../runtime-kernel/src/internal/inference/provider-recovery.ts";
import { BackendFailure, annotateFailureSummary, projectProviderRecoveryState, type ProviderRecoveryState, type InferenceEvent } from "@grokbox/runtime-kernel/contract";

const [mode, root, boundary] = process.argv.slice(2);
if (!root) throw Error("isolated root required");
const policy = { version: 1 as const, mode: "pre-output-http" as const, allowDuplicateInference: true, maxExtraRequests: 1, windowMs: 2000, baseDelayMs: 1, maxDelayMs: 5 };
const end: InferenceEvent = { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
let httpCalls = 0;
if (mode === "inspect") {
  // Forensic read of this fixture's own physical DB, not a production resume
  // path. The production opener intentionally refuses reusing an incarnation.
  const db = new ClassicLevel<string, any>(join(root,"state","modeld-execution"),{valueEncoding:"json"});
  await db.open(); const record = await db.get(`s!${sha256Text("step")}`); await db.close();
  const recovery = projectProviderRecoveryState(record?.recovery); assert(recovery); assert.equal(recovery.phase,boundary);
  const reused = await Effect.runPromise(Effect.scoped(Effect.result(openExecutionHistory(root,"isolated-node-recovery"))));
  assert.equal(reused._tag,"Failure");
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){ const history=yield* openExecutionHistory(root,"replacement-node-recovery");assert.equal(yield* history.getStep("step"),undefined); })));
  process.stdout.write(JSON.stringify({recovered:true,phase:recovery.phase,attempts:recovery.attempts.length,httpCalls:0,sameEpochRefused:true,newEpochRetired:true,autoResumed:false}));
} else await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const history = yield* openExecutionHistory(root, "isolated-node-recovery");
  const progress: RecoveryProgress = {};
  const stream = withProviderRecovery({ policy, identity: "node-step", snapshotDigest: "a".repeat(64), progress,
    beforeAttempt: () => Effect.void,
    persist: (recovery: ProviderRecoveryState) => Effect.gen(function* () {
      yield* history.putStep("step", { status: "active", snapshotDigest: "a".repeat(64), selectionRevision: "b".repeat(64), bindingId: "c".repeat(64), recovery });
      if (mode === "crash" && recovery.phase === boundary) {
        process.stdout.write(JSON.stringify({ committed: true, phase: recovery.phase }) + "\n");
        yield* Effect.forever(Effect.sleep("1 hour"));
      }
    }),
    stream: () => {
      httpCalls++;
      return httpCalls === 1 ? Stream.fail(annotateFailureSummary(new BackendFailure("provider_error"), { version: 1, code: "provider_error", phase: "provider", reason: "http", http: { status: 502 } }))
        : Stream.make({ type: "text_delta", text: "ok" } as InferenceEvent, end);
    },
  });
  const events = yield* Stream.runCollect(stream);
  const record = yield* history.getStep("step");
  assert.equal(httpCalls, 2); assert.equal(record?.recovery?.phase, "succeeded");
  assert.equal(events.filter(e => e.type === "backend_finish").length, 1);
  assert.equal(new Set(record?.recovery?.attempts.map(a => a.id)).size, 2);
  process.stdout.write(JSON.stringify({ runtime: process.version, calls: httpCalls, phase: record?.recovery?.phase, networkCalls: 0 }));
})));
