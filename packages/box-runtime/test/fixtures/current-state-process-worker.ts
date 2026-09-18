import { appendFile, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { openContinuityCurrentState } from "../../src/runtime.ts";
import { initializeCurrentRequest } from "@grokbox/runtime-kernel/continuity";
import { ownedCurrentState, CURRENT_SCOPE, type CurrentStateHooks } from "./owned-current-state.ts";
import type { ContinuityStoreHooks } from "../../src/internal/io/continuity-database.node.ts";

const [base, mode] = process.argv.slice(2);
if (!base || !mode || !basename(base).startsWith("current-state-process-")
  || await readFile(join(base, "owned-test-marker"), "utf8") !== "current-state-owned-only") throw Error("owned fixture required");
const request = initializeCurrentRequest(JSON.parse(await readFile(join(base, "request.json"), "utf8")));
const nativeHooks: CurrentStateHooks = {}, storeHooks: ContinuityStoreHooks = {};
const killSelf = (): never => { process.kill(process.pid, "SIGKILL"); throw Error("owned process should have stopped"); };
if (mode === "crash-after-claim") storeHooks.afterCommit = async label => { if (label === "claim-effect") killSelf(); };
nativeHooks.beforeCommit = async () => { await appendFile(join(base, "owned-dispatches.log"), `${request.effectId}\n`, { mode: 0o600 }); };
if (mode === "crash-after-native") nativeHooks.afterCommit = async () => { killSelf(); };
if (mode === "crash-after-reopen") nativeHooks.afterReopen = () => killSelf();
const native = await ownedCurrentState(join(base, "owned-native"), nativeHooks);
const controller = openContinuityCurrentState({ durableRoot: join(base, "durable"), scopeId: CURRENT_SCOPE,
  native: native.native, authorizeInitialization: native.authorize }, storeHooks);
let result: unknown;
if (mode === "reconcile") result = await controller.reconcile(request);
else if (mode === "envelope") result = await native.envelope("NEXT_PROCESS_INPUT");
else if (mode === "advance") { await native.advance(); result = { advanced: true }; }
else result = await controller.initialize(request);
process.stdout.write(JSON.stringify(result));
