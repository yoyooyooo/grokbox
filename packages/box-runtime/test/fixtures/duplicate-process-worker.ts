import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openAgentDuplication } from "../../src/runtime.ts";
import { duplicatePlan, isContinuityUuid, type DuplicateSource } from "@grokbox/runtime-kernel/continuity";

const [root, mode, operationId] = process.argv.slice(2);
if (!root || !["run", "kill-after-create", "kill-after-commit", "read"].includes(mode ?? "") || !isContinuityUuid(operationId)
  || readFileSync(join(root, "owned-marker"), "utf8") !== "grokbox-duplicate-process") throw Error("unowned-duplicate-fixture");
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", scopeId = "c".repeat(64);
const source = (): DuplicateSource => ({ agentId: sourceId, scopeId, generation: "d".repeat(64), profileRevision: "e".repeat(64), routineRevision: "f".repeat(64),
  harness: "box", observedAtMs: Date.now(), returnedRoutines: 0, enabledRoutines: 0, routineCoverage: "native_returned_window" });
const operation = openAgentDuplication({ durableRoot: root, scopeId, native: {
  inspectSource: async () => source(),
  duplicate: async request => {
    // An owned external-effect counter, not a real Bot or native API. Fsync
    // through a separate destination is not claimed; the observed counter is
    // only used after this process's actual append has returned.
    appendFileSync(join(root, "effects.log"), `${request.operationId}\n`);
    if (mode === "kill-after-create") process.kill(process.pid, "SIGKILL");
    return { version: 1, operationId: request.operationId, sourceAgentId: sourceId, targetAgentId: targetId,
      scopeId, generation: request.source.generation, receivedAtMs: Date.now(), evidence: "native_response" };
  },
  inspectTarget: async () => ({ agentId: targetId, state: "confirmed_box", readBack: true }),
} }, { afterCommit: async label => { if (mode === "kill-after-commit" && label === "record-duplication") process.kill(process.pid, "SIGKILL"); } });
const result = mode === "read" ? await operation.operation(operationId)
  : await operation.execute({ sourceAgentId: sourceId, operationId, expectedPlanRevision: duplicatePlan(source()).revision, confirmed: true });
console.log(JSON.stringify(result));
