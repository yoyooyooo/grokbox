import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { Effect, type Scope } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";

export type ResourceCounts = {
  listeners: number;
  sockets: number;
  fibers: number;
};

export function emptyResourceCounts(): ResourceCounts {
  return { listeners: 0, sockets: 0, fibers: 0 };
}

export type ReleaseStatus = { ok: boolean };

export type ListenHooks = {
  afterAllocate?: Effect.Effect<void>;
  /** Runs inside the owning listener Scope; faults may register a finalizer. */
  afterListen?: Effect.Effect<void, never, Scope.Scope>;
  failAfterListen?: Effect.Effect<never, Error>;
  failRelease?: boolean;
  release?: ReleaseStatus;
  onConnection?: (socket: Socket) => void;
  /** Bounded test instrumentation of the resource this Scope owns; never a CLI option. */
  onAllocated?: (server: Server) => void;
};

export type OwnedListener = {
  path: string;
  server: Server;
  ino?: number;
  dev?: number;
};

function ownsPath(path: string, ino?: number, dev?: number): boolean {
  if (ino === undefined || dev === undefined) return false;
  try {
    const st = lstatSync(path);
    return st.ino === ino && st.dev === dev;
  } catch {
    return false;
  }
}

function markRelease(hooks: ListenHooks, ok: boolean): void {
  if (hooks.release) hooks.release.ok = ok;
}

function closeErrorCode(error: Error | undefined): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
}

/**
 * libuv unlinks `pipe_fname` on uv_close even when that pathname is now a
 * competitor inode. Nulling JS `_handle` / `closeSync(fd)` avoids the unlink
 * but aborts Node 20/24 on process teardown. Make unlink fail, then close
 * the handle through Server.close so uv_close still runs.
 */
function disarmUnlink(path: string): () => void {
  const restorers: Array<() => void> = [];
  const restore = () => {
    while (restorers.length > 0) restorers.pop()?.();
  };
  try {
    if (!existsSync(path)) return restore;
    const dir = dirname(path);
    const st = lstatSync(dir);
    chmodSync(dir, st.mode & ~0o222);
    if ((lstatSync(dir).mode & 0o222) === 0) {
      restorers.push(() => {
        try { chmodSync(dir, st.mode); } catch { /* ignore */ }
      });
      return restore;
    }
    try { chmodSync(dir, st.mode); } catch { /* ignore */ }
  } catch {
    /* rename fallback */
  }
  try {
    if (!existsSync(path)) return restore;
    const guard = `${path}.grokbox-unlink-guard.${process.pid}`;
    renameSync(path, guard);
    restorers.push(() => {
      try {
        if (existsSync(guard) && !existsSync(path)) renameSync(guard, path);
      } catch { /* ignore */ }
    });
  } catch {
    /* last resort: Server.close may unlink the competitor pathname */
  }
  return restore;
}

function closeHandle(server: Server, path: string, protectPath: boolean, done: (error?: Error) => void): void {
  const restore = protectPath ? disarmUnlink(path) : () => {};
  let finished = false;
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    restore();
    done(error);
  };
  try {
    server.close((error) => {
      if (error && closeErrorCode(error) !== "ERR_SERVER_NOT_RUNNING") finish(error);
      else finish();
    });
  } catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)));
  }
}

function closeListener(
  server: Server,
  path: string,
  counts: ResourceCounts | undefined,
  owned: { ino?: number; dev?: number; released: boolean },
  hooks: ListenHooks,
) {
  return Effect.callback<void, Error>((resume) => {
    if (owned.released) {
      resume(Effect.void);
      return;
    }
    if (hooks.failRelease) {
      markRelease(hooks, false);
      resume(Effect.fail(new Error("cleanup_gap")));
      return;
    }
    const ours = ownsPath(path, owned.ino, owned.dev);
    closeHandle(server, path, !ours, (error) => {
      if (error) {
        markRelease(hooks, false);
        resume(Effect.fail(error));
        return;
      }
      owned.released = true;
      if (counts) counts.listeners = Math.max(0, counts.listeners - 1);
      markRelease(hooks, true);
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
      ? Effect.sync(() => markRelease(hooks, false)).pipe(Effect.andThen(Effect.die(new Error("cleanup_gap"))))
      : closeListener(server, path, counts, owned, hooks).pipe(Effect.orDie));
    if (hooks.onAllocated) yield* Effect.sync(() => hooks.onAllocated!(server));
    if (hooks.afterAllocate) yield* hooks.afterAllocate;
    yield* Effect.callback<void, Error>((resume, signal) => {
      let settled = false;
      const settle = (next: Effect.Effect<void, Error>) => {
        if (settled) return;
        settled = true;
        resume(next);
      };
      if (signal.aborted) {
        settle(Effect.fail(new Error("aborted")));
        return;
      }
      signal.addEventListener("abort", () => settle(Effect.fail(new Error("aborted"))), { once: true });
      server.once("error", (error) => settle(Effect.fail(error)));
      server.listen({ path, exclusive: true }, () => {
        try { chmodSync(path, 0o600); } catch { /* ignore */ }
        try {
          const st = lstatSync(path);
          owned.ino = st.ino;
          owned.dev = st.dev;
        } catch { /* ignore */ }
        settle(Effect.void);
      });
    });
    return { path, server, ino: owned.ino, dev: owned.dev };
  });
}

export function trackSocket(socket: Socket, counts?: ResourceCounts, capacity?: { clients: number }) {
  return Effect.acquireRelease(
    Effect.sync(() => socket),
    (owned) => Effect.sync(() => {
      try { owned.end(); } catch { /* ignore */ }
      try { owned.destroy(); } catch { /* ignore */ }
      if (counts) counts.sockets = Math.max(0, counts.sockets - 1);
      if (capacity) capacity.clients = Math.max(0, capacity.clients - 1);
    }),
  );
}
