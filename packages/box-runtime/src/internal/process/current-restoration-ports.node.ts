import { Effect } from "effect";
import { lstatSync } from "node:fs";
import { acquireModeldStopFence } from "../wire/modeld-stop-fence.node.ts";
import { modeldRootId, probeModeldExecution, probeModeldIdentity } from "../wire/modeld-probe.node.ts";
import { inspectPid } from "./linux.node.ts";
import { acquireRetirementObserver } from "./retirement-observer.node.ts";
import type { CurrentRestorationQualification } from "./current-restoration.ts";
import type { CurrentRestorationPorts } from "./adopt-restoration.ts";

/** The existing modeld listener owns the connection fence. Recovery never stops
 * that service and never mistakes it for retirement of native/tool delegation. */
export function acquireCurrentRestorationPorts(qualification: CurrentRestorationQualification, boxRoot: string, runRoot: string) {
  return Effect.gen(function* () {
    const observer = yield* acquireRetirementObserver();
    const own = yield* Effect.try(() => inspectPid(process.pid));
    if (!own) return yield* Effect.fail(Error("restoration-observer-owner-unavailable"));
    const modeld = qualification.resources.modeld;
    let recheckModeld: () => Promise<void>, assertModeldFence: () => void;
    if (modeld.kind === "absent") {
      assertModeldFence = () => {
        try { lstatSync(modeld.socketPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        throw Error("restoration-modeld-present");
      };
      recheckModeld = async () => assertModeldFence();
    } else {
      const fence = yield* acquireModeldStopFence(runRoot, modeld.epoch, modeldRootId(boxRoot, runRoot));
      assertModeldFence = () => { if (!fence.active()) throw Error("restoration-modeld-fence-lost"); };
      recheckModeld = async () => {
        if (!fence.active()) throw Error("restoration-modeld-fence-lost");
        const identity = await probeModeldIdentity(runRoot), state = await probeModeldExecution(runRoot);
        const e = state?.execution;
        if (!fence.active() || identity?.rootId !== modeldRootId(boxRoot, runRoot) || identity.generation !== modeld.epoch
          || state?.generation !== modeld.epoch || !e || e.admission !== "operator-fenced" || e.accepting || !e.history.available
          || e.history.lastError !== null || [e.activeSteps, e.hotStepRecords, e.hotTurns, e.pinnedTurns, e.pendingScopeReleases,
            e.authority?.active, e.authority?.waiting, e.providerRecovery?.active, e.providerRecovery?.waiting,
            e.history.reads, e.history.writes, e.history.failures, ...Object.values(e.counters)].some(value => value !== 0)) {
          throw Error("restoration-modeld-work-unproven");
        }
      };
    }
    return { observe: observer.observe, recoveryOwner: { pid: own.pid, start: own.start }, recheckModeld, assertModeldFence } satisfies CurrentRestorationPorts;
  });
}
