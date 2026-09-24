import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runControllerOperation } from "@grokbox/runtime-kernel/commands";
import { liveControlResourcesLayer, readControllerOperation, inspectControllerFacts, observeControllerHostGeneration, controllerOperationId } from "../src/internal/roots/controller-program.node.ts";
import { inspectOperationLease, operationLockPath } from "../src/internal/io/operation-lease.node.ts";
import { runTransientAdoptOperation } from "../src/internal/process/transient-adopt.ts";
import { adoptionEvidencePath } from "../src/internal/process/adopt-evidence.ts";
import { FakeProcessTree } from "./fake-tree.ts";
import { SYNTHETIC_SLICES } from "./synthetic-host.ts";
import { reviewedProfilePath } from "../src/internal/io/paths.ts";
import type { ProcessIdentity } from "../src/internal/process/process-port.ts";
const profile = { profileId: "public-review", sourceSha256: "a".repeat(64), transformedSourceSha256: "b".repeat(64), slices: SYNTHETIC_SLICES };
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper }); tree.spawn("host", { parent: supervisor });
  const classify = (row: ProcessIdentity) => { const role = tree.roles().find(item => item.pid === row.pid)?.role; return role === "wrapper" || role === "supervisor" || role === "host" || role === "temp-supervisor" ? role : null; };
  return { tree, wrapper, classify };
}
test("interruption joins original adoption before controller release and preserves actual facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "controller-interruption-")), runRoot = join(root, "run"), { tree, wrapper, classify } = fixture();
  const reached = barrier(), cancelled = barrier(), finish = barrier(); let host: ProcessIdentity | null = null;
  const layer = liveControlResourcesLayer({ inspect: () => ({ ok: true, reason: null, strategy: "transient" }), adopt: (command, signal) =>
    runTransientAdoptOperation({ signal, operationId: command.operationId, ephemeralRoot: runRoot, reviewedProfile: profile, diskSha: () => profile.sourceSha256,
      processes: tree, classify, now: Date.now, readMarker: () => null, readGatewayPid: () => null, waitGone: async row => !tree.inspect(row.pid),
      spawnTempSupervisor: async () => { const temp = tree.spawn("temp-supervisor"); host = tree.spawn("host", { parent: temp }); return temp; }, waitNewHost: async () => host,
      waitReady: async (_pid, lifetime) => { reached.resolve(); await new Promise<void>(resolve => { if (lifetime?.aborted) resolve(); else lifetime?.addEventListener("abort", () => resolve(), { once: true }); }); cancelled.resolve(); await finish.promise; return null; },
      armGuardian: async () => ({ ok: true, release: () => { tree.signal(wrapper, "SIGCONT"); } }), hasGrokboxPreload: row => row.pid === host?.pid,
    }) });
  const fiber = Effect.runFork(runControllerOperation({ intent: "apply", confirmed: true, operationId: "original", boxRoot: root, strategy: "transient" }).pipe(Effect.provide(layer)));
  await reached.promise;
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
  try {
    await cancelled.promise;
    expect((await inspectOperationLease(join(root, "state", "controller-operations.lock"))).observation.state).toBe("live");
    expect((await inspectOperationLease(operationLockPath(runRoot))).observation.state).toBe("live");
    expect(readControllerOperation(root, "original")?.state).toBe("running");
    expect(tree.signals).toHaveLength(3);
  } finally { finish.resolve(); await interrupted; }
  const row = readControllerOperation(root, "original");
  expect(row).toMatchObject({ state: "unknown", prefix: { signaled: true, spawned: true, guardian: true, diagnostic: { code: "operation-cancelled", phase: "spawn-temp" } } });
  for (const path of [join(root, "state", "controller-operations.lock"), operationLockPath(runRoot)]) expect((await inspectOperationLease(path)).observation.state).toBe("missing");
  expect(JSON.parse(await readFile(adoptionEvidencePath(runRoot, "original", "journal"), "utf8")).failure).toEqual(row?.prefix?.diagnostic);
});

test("a newly derived Host generation cannot signal an unresolved survivor or replace its original journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "controller-survivor-")), runRoot = join(root, "run"), { tree, wrapper, classify } = fixture();
  await mkdir(join(root, "profiles"), { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }));
  await writeFile(join(root, "models.json"), JSON.stringify({ version: 3, models: {}, assignments: { main: null, agents: {} } }));
  await writeFile(reviewedProfilePath(root), JSON.stringify(profile));
  for (const row of tree.procs.values()) if (row.role === "host") row.ident.cmdline = ["node", "/fixture/host-main.cjs"];
  let survivor: ProcessIdentity | null = null, activeId = "original", gateway = tree.roles().find(row => row.role === "host")!.pid;
  const signal = tree.signal.bind(tree); tree.signal = (identity, sig) => activeId === "original" && identity.pid === survivor?.pid && sig === "SIGTERM" ? { ok: true } : signal(identity, sig);
  const live = { processes: tree, classify, gatewayPid: () => gateway, hostBundlePath: "/fixture/host-main.cjs", readHostSha: () => profile.sourceSha256 };
  const layer = liveControlResourcesLayer({ inspect: () => inspectControllerFacts(root, live), adopt: (command, cancellation) => {
    activeId = command.operationId; const ownership = new AbortController(); let released = false;
    return runTransientAdoptOperation({ signal: cancellation, operationId: command.operationId, ephemeralRoot: runRoot, reviewedProfile: profile, diskSha: () => profile.sourceSha256,
      processes: tree, classify, now: Date.now, readMarker: () => null, readGatewayPid: () => gateway, waitGone: async row => !tree.inspect(row.pid),
      spawnTempSupervisor: async () => { const temp = tree.spawn("temp-supervisor"); const born = tree.spawn("host", { parent: temp }); tree.procs.get(born.pid)!.ident.cmdline = ["node", "/fixture/host-main.cjs"]; survivor = tree.inspect(born.pid); return temp; },
      waitNewHost: async () => survivor, waitReady: async () => { gateway = survivor!.pid; ownership.abort(); return null; },
      armGuardian: async () => ({ ok: true, signal: ownership.signal, end: () => ownership.signal.aborted ? "expired" : "active", release: () => { if (!released) { released = true; tree.signal(wrapper, "SIGCONT"); tree.spawn("supervisor", { parent: wrapper }); } } }),
      hasGrokboxPreload: row => row.pid === survivor?.pid });
  } });
  const run = (operationId: string) => Effect.runPromise(runControllerOperation({ intent: "apply", confirmed: true, operationId, boxRoot: root, strategy: "transient" }).pipe(Effect.provide(layer)));
  expect((await run("original")).diagnostic?.cleanup?.find(row => row.role === "host")?.outcome).toBe("unproven");
  const original = readControllerOperation(root, "original"), bytes = await readFile(join(runRoot, "state", "adopt-op.json"));
  const next = controllerOperationId("apply", root, { hostGeneration: observeControllerHostGeneration(live)! });
  expect(inspectControllerFacts(root, live).ok).toBe(true);
  const before = tree.signals.length;
  expect(await run(next)).toMatchObject({ signaled: false, reason: "unresolved-adoption-owner" });
  expect(tree.signals).toHaveLength(before);
  expect(await readFile(join(runRoot, "state", "adopt-op.json"))).toEqual(bytes);
  expect(await readFile(adoptionEvidencePath(runRoot, "original", "journal"))).toEqual(bytes);
  expect(readControllerOperation(root, "original")).toEqual(original);
});
