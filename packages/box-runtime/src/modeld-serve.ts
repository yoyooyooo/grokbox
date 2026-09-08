import { chmod, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { Effect, Exit, Schedule, Scope } from "effect";
import { BoxRuntimeError } from "./errors.ts";
import { createModeld, type ModelD, type ModeldDriver, type ModeldPorts } from "./modeld.ts";
import {
  createDefaultCredentialFingerprint,
  createDefaultModeldDriver,
  type DefaultModeldDriverOptions,
} from "./modeld-default.ts";
import { modeldStorePorts } from "./modeld-store.ts";
import {
  attachClient,
  closeServer,
  isAddrInUse,
  listenUnix,
  modeldSocketPath,
  socketInUse,
  type StubModeldServer,
} from "./modeld-ipc.ts";
import { appendProviderErrorObserved } from "./events.ts";

export type { StubModeldServer };

export type StartStubModeldServerInput = {
  runRoot: string; durableRoot: string; signal?: AbortSignal;
  ports?: ModeldPorts; driver?: ModeldDriver; now?: () => number; budgetMs?: number; idleTtlMs?: number; maxRecords?: number;
  defaultDriver?: DefaultModeldDriverOptions;
};

type Bound = {
  kernel: ModelD;
  server: Server;
  clients: Set<Socket>;
  socketPath: string;
  owned: { dev: number; ino: number } | null;
  stopped: Promise<void>;
};

async function bindUnixKernel(input: StartStubModeldServerInput): Promise<Bound> {
  const socketPath = modeldSocketPath(input.runRoot);
  await mkdir(input.runRoot, { recursive: true, mode: 0o700 });
  await chmod(input.runRoot, 0o700).catch(() => undefined);
  if (await socketInUse(socketPath)) throw new BoxRuntimeError("invalid_usage", "modeld socket is owned by a live competitor.");
  const defaultDriver: DefaultModeldDriverOptions = {
    ...(input.defaultDriver ?? {}),
    onProviderError: input.defaultDriver?.onProviderError ?? (async (evidence) => {
      await appendProviderErrorObserved(input.durableRoot, {
        name: "provider_error_observed",
        schemaVersion: 1,
        at: new Date().toISOString(),
        ...evidence,
      });
    }),
  };
  const usingDefaultDriver = input.driver === undefined;
  const ports = {
    ...modeldStorePorts(input.durableRoot, input.runRoot),
    ...(usingDefaultDriver
      ? { credentialFingerprint: createDefaultCredentialFingerprint(defaultDriver.env ?? process.env) }
      : {}),
    ...input.ports,
  };
  const kernel = createModeld({
    ...ports,
    driver: input.driver ?? createDefaultModeldDriver(defaultDriver),
    now: input.now, budgetMs: input.budgetMs, idleTtlMs: input.idleTtlMs, maxRecords: input.maxRecords,
  });
  const clients = new Set<Socket>();
  const server: Server = createServer((socket) => {
    if (clients.size >= 64) { socket.destroy(); return; }
    clients.add(socket); socket.once("close", () => clients.delete(socket)); attachClient(socket, kernel);
  });
  try {
    try { await listenUnix(server, socketPath); }
    catch (error) {
      if (!isAddrInUse(error)) throw error;
      if (await socketInUse(socketPath)) throw new BoxRuntimeError("invalid_usage", "modeld socket is owned by a live competitor.");
      const stale = await lstat(socketPath);
      if (!stale.isSocket() || (process.getuid && stale.uid !== process.getuid())) {
        throw new BoxRuntimeError("invalid_usage", "modeld path is not an owned stale socket.");
      }
      await unlink(socketPath); await listenUnix(server, socketPath);
    }
  } catch (error) {
    kernel.stop();
    for (const socket of clients) socket.destroy();
    await closeServer(server);
    throw error;
  }
  await chmod(socketPath, 0o600).catch(() => undefined);
  const owned = await lstat(socketPath).then((info) => ({ dev: info.dev, ino: info.ino })).catch(() => null);
  const stopped = new Promise<void>((resolve) => server.once("close", resolve));
  return { kernel, server, clients, socketPath, owned, stopped };
}

async function releaseBound(bound: Bound, socketPath: string): Promise<void> {
  bound.kernel.stop();
  for (const socket of bound.clients) socket.destroy();
  let displaced: string | null = null;
  if (bound.owned) {
    try {
      const current = await lstat(socketPath);
      if (current.dev !== bound.owned.dev || current.ino !== bound.owned.ino) {
        displaced = `${socketPath}.keep.${process.pid}`;
        await rename(socketPath, displaced);
      }
    } catch { /* path already gone */ }
  }
  await closeServer(bound.server);
  if (displaced) { await rename(displaced, socketPath).catch(() => undefined); return; }
  if (!bound.owned) return;
  try {
    const current = await lstat(socketPath);
    if (current.dev === bound.owned.dev && current.ino === bound.owned.ino) await unlink(socketPath);
  } catch { /* socket already gone or not ours */ }
}

/**
 * E3: Effect owns listen lifetime, sweep Fiber, and stop. Kernel admit/pin stays `createModeld`.
 * Preload/seam/session must not import this file.
 */
export const openModeldServer = Effect.fn("openModeldServer")(function* (input: StartStubModeldServerInput) {
  const socketPath = modeldSocketPath(input.runRoot);
  const bound = yield* Effect.tryPromise({
    try: () => bindUnixKernel(input),
    catch: (error) => error instanceof BoxRuntimeError ? error : new BoxRuntimeError("invalid_usage", "modeld listen failed."),
  });
  const sweepMs = Math.min(1000, input.idleTtlMs ?? 1000);
  yield* Effect.forkScoped(
    Effect.repeat(Effect.sync(() => bound.kernel.sweep()), Schedule.spaced(sweepMs)),
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => releaseBound(bound, socketPath)));
  return bound;
});

export async function startStubModeldServer(input: StartStubModeldServerInput): Promise<StubModeldServer> {
  const scope = await Effect.runPromise(Scope.make());
  const bound = await Effect.runPromise(openModeldServer(input).pipe(Effect.provideService(Scope.Scope, scope)));
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= Effect.runPromise(Scope.close(scope, Exit.void));
  const onAbort = () => { void stop(); };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) await stop();
  return {
    socketPath: bound.socketPath,
    serverGeneration: bound.kernel.serverGeneration,
    dispatches: () => bound.kernel.stats().dispatches,
    admissionStats: bound.kernel.stats,
    stop,
    wait: async () => { await bound.stopped; await stopping; },
  };
}
