import { Effect } from "effect";
import { lstatSync } from "node:fs";
import { acquireAdvisoryGate } from "../io/advisory-gate.node.ts";
import { modeldSocketPath } from "../wire/modeld-probe.node.ts";
import { inspectPid, strictLinuxObservationPort } from "./linux.node.ts";
import { acquireRetirementObserver } from "./retirement-observer.node.ts";
import type { CurrentRestorationQualification } from "./current-restoration.ts";
import type { CurrentRestorationPorts } from "./adopt-restoration.ts";

/** The service owner must already be stopped. Hold the SAME OFD gate used by
 * acquireServiceSocket before listen, without registering or removing any owner.
 * Its lifetime is this Scope, not a transport-close callback on an event loop. */
export function acquireCurrentRestorationPorts(qualification: CurrentRestorationQualification, runRoot: string) {
  return Effect.gen(function* () {
    const path = modeldSocketPath(runRoot);
    if (qualification.resources.modeld.socketPath !== path) return yield* Effect.fail(Error("restoration-modeld-scope-conflict"));
    const gate = yield* Effect.acquireRelease(
      Effect.tryPromise(() => acquireAdvisoryGate(`${path}.gate`)),
      held => held ? Effect.promise(held.release) : Effect.void,
    );
    if (!gate) return yield* Effect.fail(Error("restoration-modeld-busy"));
    const processes = strictLinuxObservationPort();
    const assertModeldAbsent = () => {
      for (const owner of qualification.resources.modeld.owners) {
        if (processes.inspectLifetime!(owner.pid)?.start === owner.start) throw Error("restoration-modeld-owner-present");
      }
      try { lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      throw Error("restoration-modeld-present");
    };
    yield* Effect.try(assertModeldAbsent);
    const observer = yield* acquireRetirementObserver();
    const own = yield* Effect.try(() => inspectPid(process.pid));
    if (!own) return yield* Effect.fail(Error("restoration-observer-owner-unavailable"));
    return { observe: observer.observe, recoveryOwner: { pid: own.pid, start: own.start }, assertModeldAbsent } satisfies CurrentRestorationPorts;
  });
}
