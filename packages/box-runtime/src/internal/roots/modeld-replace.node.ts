import { spawn } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Effect } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { linuxProcessPort } from "../process/linux.node.ts";
import { signalIfMatch, stableIdentitiesMatch } from "../process/process-port.ts";
import { modeldRootId, modeldSocketPath, probeModeldIdentity, probeModeldExecution, probeModeldReplacement } from "../wire/modeld-probe.node.ts";

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

/** Explicit operator replacement, never automatic request retry. Only an exact
 * current-epoch, same-root modeld socket owner may receive SIGTERM. No Host kill,
 * no SIGKILL, no socket unlink, no borrowed-process claim, no coordinator edits. */
export async function replaceModeld(input: {
  durableRoot: string; runRoot: string; expectedEpoch: string; entry: string;
  noManagedBotsRunning: boolean; confirmed: boolean; env: NodeJS.ProcessEnv;
}) {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    if (!input.confirmed || !input.noManagedBotsRunning || !isAbsolute(input.entry) || !input.entry.endsWith("/dist/index.js")) return yield* Effect.fail(refuse("modeld replacement requires confirmation, a packed entry and idle managed Bots"));
    const previous = yield* Effect.promise(() => probeModeldReplacement(input.runRoot, 1000));
    if (!previous || previous.generation !== input.expectedEpoch || previous.rootId !== modeldRootId(input.durableRoot, input.runRoot)) return yield* Effect.fail(refuse("modeld replacement identity changed or root mismatched"));
    if (previous.execution.activeSteps > 0) return yield* Effect.fail(refuse("modeld still has active work"));
    const port = linuxProcessPort();
    const owners = yield* Effect.tryPromise({ try: () => socketOwners(modeldSocketPath(input.runRoot)), catch: () => refuse("modeld socket owner unavailable") });
    const candidates = [...owners].map(pid => port.inspect(pid)).filter(p => p && p.uid === process.getuid?.()
      && p.cmdline.some((v, i, a) => v === "runtime" && a[i + 1] === "modeld" && a[i + 2] === "run"));
    if (candidates.length !== 1 || !candidates[0]) return yield* Effect.fail(refuse("modeld does not have one verified process owner"));
    const target = candidates[0];
    if (!/\/node(?:js)?$/.test(target.exe)) return yield* Effect.fail(refuse("replacement requires a verified Node modeld process"));
    const again = yield* Effect.promise(() => probeModeldReplacement(input.runRoot, 1000));
    if (again?.generation !== input.expectedEpoch || again.rootId !== previous.rootId || again.wireVersion !== previous.wireVersion
      || again.execution.activeSteps > 0) return yield* Effect.fail(refuse("modeld changed before replacement"));
    const signaled = yield* Effect.sync(() => signalIfMatch(port, target, "SIGTERM"));
    if (!signaled.ok) return yield* Effect.fail(refuse("modeld process identity changed before signal"));
    yield* Effect.gen(function* () {
      while (stableIdentitiesMatch(target, port.inspect(target.pid))) yield* Effect.sleep("50 millis");
    }).pipe(Effect.timeout("10 seconds"));
    // The prior process must remove its own socket during normal Scope cleanup.
    if ((yield* Effect.promise(() => probeModeldReplacement(input.runRoot, 500))) !== null) return yield* Effect.fail(refuse("a different modeld took ownership; replacement not started"));
    // The service writes its own bounded, schema-projected lifecycle segments.
    // Do not leave detached stdout/stderr holding an unbounded raw-log fd, and
    // do not put an ephemeral CLI in charge of a long-lived child's log pipes.
    let published = false;
    const child = yield* Effect.acquireRelease(Effect.sync(() => spawn(target.exe, [input.entry, "runtime", "modeld", "run", "--json"], {
      detached: true, stdio: "ignore", env: { ...input.env, GROKBOX_RUN_ROOT: input.runRoot, GROKBOX_BOX_RUNTIME_ROOT: input.durableRoot },
    })), child => Effect.sync(() => {
      if (published) child.unref();
      else if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
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
  })));
}
