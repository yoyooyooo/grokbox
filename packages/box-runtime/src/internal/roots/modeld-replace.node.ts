import { spawn } from "node:child_process";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Clock, Effect } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { linuxProcessPort } from "../process/linux.node.ts";
import { signalIfMatch, stableIdentitiesMatch } from "../process/process-port.ts";
import { modeldRootId, modeldSocketPath, probeModeldIdentity, probeModeldExecution, probeModeldReplacement } from "../wire/modeld-probe.node.ts";
import { acquireModeldStopFence } from "../wire/modeld-stop-fence.node.ts";

const refuse = (message: string) => new BoxRuntimeError("invalid_usage", message);
async function socketOwners(path: string): Promise<Set<number>> {
  const rows = (await readFile("/proc/net/unix", "utf8")).split("\n").map(l => l.trim().split(/\s+/));
  const inodes = new Set(rows.filter(r => r[7] === path && r[3] === "00010000").map(r => `socket:[${r[6]}]`));
  const owners = new Set<number>();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      for (const fd of await readdir(`/proc/${entry}/fd`)) {
        if (inodes.has(await readlink(`/proc/${entry}/fd/${fd}`))) { owners.add(Number(entry)); break; }
      }
    } catch { /* disappeared/foreign process: never a signal target */ }
  }
  return owners;
}

export type ModeldControlInput = {
  durableRoot: string; runRoot: string; expectedEpoch: string;
  noManagedBotsRunning: boolean; confirmed: boolean; signal?: AbortSignal;
};

/** Both operator actions use the same owner/epoch gate. Persisted unknown
 * requests remain in the original ledger; stopping never settles or replays them. */
function stopVerifiedModeld(input: ModeldControlInput, onSignaled: () => void) {
  return Effect.gen(function* () {
    if (!input.confirmed || !input.noManagedBotsRunning) return yield* Effect.fail(refuse("modeld control requires confirmation and idle managed Bots"));
    const previous = yield* Effect.promise(() => probeModeldReplacement(input.runRoot, 1000));
    if (!previous || previous.generation !== input.expectedEpoch || previous.rootId !== modeldRootId(input.durableRoot, input.runRoot)) return yield* Effect.fail(refuse("modeld control identity changed or root mismatched"));
    const idle = (execution: typeof previous.execution) => execution.activeSteps === 0
      && (execution.pendingScopeReleases ?? 0) === 0
      && (execution.providerRecovery?.active ?? 0) === 0
      && (execution.authority?.active ?? 0) === 0;
    if (!idle(previous.execution)) return yield* Effect.fail(refuse("modeld still has active work"));
    const fence = yield* acquireModeldStopFence(input.runRoot, input.expectedEpoch, previous.rootId);
    const port = linuxProcessPort();
    const owners = yield* Effect.tryPromise({ try: () => socketOwners(modeldSocketPath(input.runRoot)), catch: () => refuse("modeld socket owner unavailable") });
    const candidates = [...owners].map(pid => port.inspect(pid)).filter(p => p && p.uid === process.getuid?.()
      && p.cmdline.some((v, i, a) => v === "runtime" && a[i + 1] === "modeld" && a[i + 2] === "run"));
    if (owners.size !== 1 || candidates.length !== 1 || !candidates[0]) return yield* Effect.fail(refuse("modeld does not have one verified process owner"));
    const target = candidates[0];
    if (!/\/node(?:js)?$/.test(target.exe)) return yield* Effect.fail(refuse("modeld control requires a verified Node process"));
    const again = yield* Effect.promise(() => probeModeldReplacement(input.runRoot, 1000));
    if (again?.generation !== input.expectedEpoch || again.rootId !== previous.rootId || again.wireVersion !== previous.wireVersion
      || !idle(again.execution)) return yield* Effect.fail(refuse("modeld changed before signal"));
    const finalOwners = yield* Effect.tryPromise({ try: () => socketOwners(modeldSocketPath(input.runRoot)), catch: () => refuse("modeld socket owner unavailable") });
    if (finalOwners.size !== 1 || !finalOwners.has(target.pid)) return yield* Effect.fail(refuse("modeld socket owner changed before signal"));
    // After SIGTERM, join the original owner's cleanup even if the caller
    // cancels. No subsequent replacement spawn inherits that cancellation.
    return yield* Effect.uninterruptible(Effect.gen(function* () {
      const signaled = yield* Effect.sync(() => {
        input.signal?.throwIfAborted();
        if (!fence.active()) throw refuse("modeld idle-stop fence was lost before signal");
        const result = signalIfMatch(port, target, "SIGTERM");
        if (result.ok) onSignaled();
        return result;
      });
      if (!signaled.ok) return yield* Effect.fail(refuse("modeld process identity changed before signal"));
      const clock = yield* Clock.Clock;
      const deadline = clock.monotonicTimeNanosUnsafe() + 10_000_000_000n;
      while (stableIdentitiesMatch(target, port.inspect(target.pid))) {
        if (clock.monotonicTimeNanosUnsafe() >= deadline) return yield* Effect.fail(refuse("modeld cleanup_gap: signaled process has not exited"));
        yield* Effect.sleep("50 millis");
      }
      const absent = yield* Effect.promise(async () => {
        try { await lstat(modeldSocketPath(input.runRoot)); return false; }
        catch (error) { return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
      });
      if (!absent) return yield* Effect.fail(refuse("modeld cleanup_gap: socket remains or changed owner"));
      return { previous, target };
    }));
  });
}

/** Controlled-window cleanup for the exact observed modeld. Does not require a
 * persistent service manager and does not install an autostart owner. */
export async function stopModeld(input: ModeldControlInput) {
  let signaled = false;
  return Effect.runPromise(Effect.scoped(stopVerifiedModeld(input, () => { signaled = true; }).pipe(Effect.map(({ previous, target }) => ({
    stopped: true, previousEpoch: previous.generation, previousWireVersion: previous.wireVersion,
    previousPid: target.pid, rootId: previous.rootId, socketAbsent: true,
    hostRestarted: false, oldRequestsReplayed: false, historyPreserved: true,
  })))), { signal: input.signal }).catch(error => {
    if (signaled && input.signal?.aborted) throw refuse("modeld control cancelled after SIGTERM; inspect the original epoch and process before recovery");
    throw error;
  });
}

/** Explicit operator replacement, never automatic request retry. Only an exact
 * current-epoch, same-root modeld socket owner may receive SIGTERM. No Host kill,
 * no SIGKILL, no socket unlink, no borrowed-process claim, no coordinator edits. */
export async function replaceModeld(input: ModeldControlInput & { entry: string; env: NodeJS.ProcessEnv }) {
  let signaled = false;
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    if (!input.confirmed || !input.noManagedBotsRunning || !isAbsolute(input.entry) || !input.entry.endsWith("/dist/index.js")) return yield* Effect.fail(refuse("modeld replacement requires confirmation, a packed entry and idle managed Bots"));
    const { previous, target } = yield* stopVerifiedModeld(input, () => { signaled = true; });
    yield* Effect.sync(() => input.signal?.throwIfAborted());
    // The service writes its own bounded, schema-projected lifecycle segments.
    // Do not leave detached stdout/stderr holding an unbounded raw-log fd, and
    // do not put an ephemeral CLI in charge of a long-lived child's log pipes.
    let published = false;
    const child = yield* Effect.acquireRelease(Effect.sync(() => {
      input.signal?.throwIfAborted();
      return spawn(target.exe, [input.entry, "runtime", "modeld", "run", "--json"], {
        detached: true, stdio: "ignore", env: { ...input.env, GROKBOX_RUN_ROOT: input.runRoot, GROKBOX_BOX_RUNTIME_ROOT: input.durableRoot },
      });
    }), child => Effect.promise(async () => {
      if (published) { child.unref(); return; }
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); child.off("exit", done); child.off("error", done); resolve(); };
        const timer = setTimeout(() => { child.off("exit", done); child.off("error", done); reject(refuse("replacement modeld cleanup_gap after cancellation")); }, 10000);
        child.once("exit", done); child.once("error", done);
        child.kill("SIGTERM");
      });
    }));
    let spawnError = false;
    child.once("error", () => { spawnError = true; });
    const ready = yield* Effect.gen(function* () {
      for (;;) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null) return yield* Effect.fail(refuse("replacement modeld failed to start"));
        const observed = yield* Effect.promise(() => probeModeldIdentity(input.runRoot, 500));
        const status = observed ? yield* Effect.promise(() => probeModeldExecution(input.runRoot, 500)) : null;
        if (observed?.rootId === previous.rootId && observed.generation !== previous.generation
          && status?.generation === observed.generation && status.execution.accepting && status.execution.history.kind === "leveldb") return { ...observed, execution: status.execution };
        yield* Effect.sleep("100 millis");
      }
    }).pipe(Effect.timeout("10 seconds"));
    const newOwners = yield* Effect.promise(() => socketOwners(modeldSocketPath(input.runRoot)));
    if (!child.pid || newOwners.size !== 1 || !newOwners.has(child.pid)) return yield* Effect.fail(refuse("replacement socket is not owned by the launched process"));
    published = true;
    return { replaced: true, previousEpoch: previous.generation, previousWireVersion: previous.wireVersion, serviceEpoch: ready.generation, previousPid: target.pid,
      pid: child.pid, execution: ready.execution, liveEntry: input.entry, hostRestarted: false, oldRequestsReplayed: false };
  })), { signal: input.signal }).catch(error => {
    if (signaled && input.signal?.aborted) throw refuse("modeld replacement cancelled after SIGTERM; inspect the original and replacement epochs before recovery");
    throw error;
  });
}
