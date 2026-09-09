import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
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
};

export type OwnedListener = {
  path: string;
  server: Server;
};

function closeListener(server: Server, path: string, counts?: ResourceCounts, owned?: { current: boolean }) {
  return Effect.callback<void>((resume) => {
    server.close(() => {
      if (owned?.current) {
        try { unlinkSync(path); } catch { /* already gone */ }
        owned.current = false;
      }
      if (counts) counts.listeners = Math.max(0, counts.listeners - 1);
      resume(Effect.void);
    });
  });
}

/** Bind Unix listener. Finalizer is registered at allocation, before listen completes. Never unlinks a competitor path. */
export function acquireUnixListener(path: string, counts?: ResourceCounts, hooks: ListenHooks = {}) {
  return Effect.gen(function* () {
    if (existsSync(path)) {
      return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "modeld socket exists"));
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const server = createServer();
    const owned = { current: false };
    if (counts) counts.listeners += 1;
    yield* Effect.addFinalizer(() => closeListener(server, path, counts, owned).pipe(Effect.ignore));
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
        owned.current = true;
        resume(Effect.void);
      });
      return Effect.sync(onAbort);
    });
    if (hooks.afterListen) yield* hooks.afterListen;
    if (hooks.failAfterListen) yield* hooks.failAfterListen;
    return { path, server };
  });
}

export function trackSocket(socket: Socket, counts?: ResourceCounts) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      if (counts) counts.sockets += 1;
      return socket;
    }),
    (owned) => Effect.sync(() => {
      owned.destroy();
      if (counts) counts.sockets = Math.max(0, counts.sockets - 1);
    }),
  );
}
