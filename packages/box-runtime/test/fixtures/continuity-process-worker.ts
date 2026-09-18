import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { openContinuityRecoveryStore } from "../../src/internal/roots/continuity.runtime.ts";
import { materialFixture, CONT_SCOPE, CONT_POLICY } from "./continuity-material.ts";

// Test-only child. Parent creates this marker in its own mkdtemp; no real Bot,
// Host, account, configuration migration or service signal is involved.
const [mode, root, requestId, effectId] = process.argv.slice(2);
if (!mode || !root || !requestId || await readFile(join(root, "owned-test-marker"), "utf8") !== "continuity-process-fixture") throw Error("owned fixture required");
const input = materialFixture("process-state", 1234); input.requestId = requestId;
const crash = () => { process.kill(process.pid, "SIGKILL"); throw Error("SIGKILL did not terminate test child"); };
const store = openContinuityRecoveryStore({ durableRoot: root, scopeId: CONT_SCOPE }, {
  afterReservation: mode === "crash-reservation" ? async () => crash() : undefined,
  afterObject: mode === "crash-after-objects" ? async index => { if (index === input.content.size - 1) crash(); } : undefined,
  beforeCommit: mode === "crash-before-commit" ? async label => { if (label === "publish-material") crash(); } : undefined,
});
let result: unknown;
if (["publish", "crash-reservation", "crash-after-objects", "crash-before-commit"].includes(mode)) result = await store.publish(input);
else if (mode === "reconcile") result = await store.reconcilePublication(requestId, "verify");
else if (mode === "read") {
  const read = await store.readSnapshot(requestId);
  result = { state: read.state, revision: read.reference.revision, values: [...read.content.values()].map(v => new TextDecoder().decode(v)), nativeImportProven: read.nativeImportProven };
} else if (["claim", "crash-claim", "crash-after-effect"].includes(mode)) {
  if (!effectId) throw Error("effect id required");
  const claim = await store.claimEffect(requestId, effectId, CONT_POLICY);
  if (claim.dispatch) {
    if (mode === "crash-claim") crash();
    await appendFile(join(root, "owned-effects.log"), `${effectId}\n`, { mode: 0o600 });
    if (mode === "crash-after-effect") crash();
  }
  result = claim;
} else throw Error("unsupported owned test mode");
process.stdout.write(JSON.stringify(result) + "\n");
