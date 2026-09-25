import { spawn } from "node:child_process";
import { Effect } from "effect";
import { resolveRuntimeHelper, RUNTIME_HELPER_RETIREMENT_OBSERVER } from "./helpers/runtime-helpers.ts";
import type { Lifetime } from "./restoration-proof.ts";
import type { CurrentRestorationQualification, RetirementObservation } from "./current-restoration.ts";

export type RetirementObserver = { observe: (qualification: CurrentRestorationQualification, targets: { hosts: Lifetime[]; markerPid: number }) => Promise<RetirementObservation> };

/** One scoped child, no signals, retries or detached work. EOF joins its current
 * bounded local observation before either recovery gate may be released. */
export function acquireRetirementObserver() {
  return Effect.gen(function* () {
    const observer = yield* Effect.acquireRelease(Effect.sync(() => {
      if (process.platform !== "linux" || process.arch !== "x64") throw Error("restoration-observer-platform-unavailable");
      const child = spawn("python3", ["-I", "-S", resolveRuntimeHelper(RUNTIME_HELPER_RETIREMENT_OBSERVER)], {
        stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      });
      let readyResolve!: () => void, readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      void ready.catch(() => undefined);
      let pending: { resolve: (value: RetirementObservation) => void; reject: (error: Error) => void } | undefined;
      let buffer = "", closed = false, initialized = false;
      const fail = () => {
        closed = true;
        const error = Error("restoration-observer-unavailable"); readyReject(error); pending?.reject(error); pending = undefined;
        child.stdin.end();
      };
      child.on("error", fail); child.stdin.on("error", fail);
      const joined = new Promise<void>(resolve => child.once("close", () => { fail(); resolve(); }));
      child.stdout.on("data", (chunk: Buffer) => {
        if (closed) return;
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { fail(); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const row = JSON.parse(line);
            if (!initialized) {
              if (row.version !== 1 || row.ready !== true) throw Error();
              initialized = true; readyResolve();
            } else {
              if (!pending) throw Error();
              const current = pending; pending = undefined;
              if (row.ok !== true) {
                const d = row.diagnostic;
                const stages = ["unknown", "context", "census", "image", "descriptors", "observe", "modeld_absent", "exited_fd_table", "process_gone", "address", "relevant_preload", "opened", "file_stamp", "regions", "main"];
                const safe = d && stages.includes(d.stage) && [d.line, d.errno, d.pid].every(value => Number.isSafeInteger(value) && value >= 0);
                const detail = safe ? `-at-${d.stage.replaceAll("_", "-")}-line-${d.line}-errno-${d.errno}-pid-${d.pid}` : "";
                current.reject(Error(`restoration-observation-unproved${detail}`));
              } else current.resolve(row.observation);
            }
          } catch { fail(); }
        }
      });
      return { ready, observe: async (qualification: CurrentRestorationQualification, targets: { hosts: Lifetime[]; markerPid: number }) => {
        await ready;
        if (closed || pending) throw Error("restoration-observer-unavailable");
        return new Promise<RetirementObservation>((resolve, reject) => {
          pending = { resolve, reject };
          child.stdin.write(`${JSON.stringify({ qualification, targets })}\n`);
        });
      }, close: async () => { closed = true; child.stdin.end(); await joined; } };
    }), observer => Effect.promise(observer.close));
    yield* Effect.tryPromise(() => observer.ready);
    return observer satisfies RetirementObserver;
  });
}
