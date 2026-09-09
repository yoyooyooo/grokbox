import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { Effect } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";

export type ResourceCounts = {
  listeners: number;
  sockets: number;
  fibers: number;
};

export function emptyResourceCounts(): ResourceCounts {
  return { listeners: 0, sockets: 0, fibers: 0 };
}

export type ListenHooks = {
  afterAllocate?: Effect.Effect<void>;
  afterListen?: Effect.Effect<void>;
  failAfterListen?: Effect.Effect<never, Error>;
  failRelease?: boolean;
  onConnection?: (socket: Socket) => void;
};

export type OwnedListener = {
  path: string;
  server: Server;
  ino?: number;
  dev?: number;
};

type PipeServer = Server & { _pipeName?: string };

function ownsPath(path: string, ino?: number, dev?: number): boolean {
  if (ino === undefined || dev === undefined) return false;
  try {
    const st = lstatSync(path);
    return st.ino === ino && st.dev === dev;
  } catch {
    return false;
  }
}

function closeListener(
  server: Server,
  path: string,
  counts: ResourceCounts | undefined,
  owned: { ino?: number; dev?: number; released: boolean },
  failRelease: boolean,
) {
  return Effect.callback<void, Error>((resume) => {
    if (owned.released) {
      resume(Effect.void);
      return;
    }
    if (failRelease) {
      resume(Effect.fail(new Error("cleanup_gap")));
      return;
    }
    const pipe = server as PipeServer;
    if (!ownsPath(path, owned.ino, owned.dev)) {
      pipe._pipeName = undefined;
    }
    server.close((error) => {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (error && code !== "ERR_SERVER_NOT_RUNNING") {
        resume(Effect.fail(error));
        return;
      }
      owned.released = true;
      if (counts) counts.listeners = Math.max(0, counts.listeners - 1);
      resume(Effect.void);
    });
  });
}

/** Bind Unix listener. Finalizer at allocation. Never unlinks a competitor pathname. */
export function acquireUnixListener(path: string, counts?: ResourceCounts, hooks: ListenHooks = {}) {
  return Effect.gen(function* () {
    if (existsSync(path)) {
      return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "modeld socket exists"));
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const server = createServer();
    const owned = { ino: undefined as number | undefined, dev: undefined as number | undefined, released: false };
    if (counts) counts.listeners += 1;
    if (hooks.onConnection) server.on("connection", hooks.onConnection);
    yield* Effect.addFinalizer(() => hooks.failRelease === true
      ? Effect.die(new Error("cleanup_gap"))
      : closeListener(server, path, counts, owned, false).pipe(Effect.orDie));
    if (hooks.afterAllocate) yield* hooks.afterAllocate;
    yield* Effect.callback<void, Error>((resume, signal) => {
      const onAbort = () => {
        try { server.close(); } catch { /* ignore */ }
      };
      if (signal.aborted) {
        onAbort();
        resume(Effect.fail(new Error("aborted")));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen({ path, exclusive: true }, () => {
        try { chmodSync(path, 0o600); } catch { /* ignore */ }
        try {
          const st = lstatSync(path);
          owned.ino = st.ino;
          owned.dev = st.dev;
        } catch { /* ignore */ }
        resume(Effect.void);
      });
      return Effect.sync(onAbort);
    });
    if (hooks.afterListen) yield* hooks.afterListen;
    if (hooks.failAfterListen) yield* hooks.failAfterListen;
    return { path, server, ino: owned.ino, dev: owned.dev };
  });
}

export function trackSocket(socket: Socket, counts?: ResourceCounts, capacity?: { clients: number }) {
  return Effect.acquireRelease(
    Effect.sync(() => socket),
    (owned) => Effect.callback<void>((resume) => {
      owned.end();
      owned.destroy();
      if (counts) counts.sockets = Math.max(0, counts.sockets - 1);
      if (capacity) capacity.clients = Math.max(0, capacity.clients - 1);
      resume(Effect.void);
    }),
  );
}
