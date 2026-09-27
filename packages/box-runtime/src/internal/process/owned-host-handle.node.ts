import { spawn } from "node:child_process";
import { resolveRuntimeHelper, RUNTIME_HELPER_OWNED_HOST_RETIREMENT } from "./helpers/runtime-helpers.ts";

export type RetirementTarget = {
  pid: number; start: number; uid: number; exeDigest: string; argvDigest: string;
  operationId: string; mode: "identity" | "route"; rootDigest: string; targetDigest: string;
};
export type HostSignalHandle = {
  terminate: () => Promise<{ signaled: boolean; exitObserved: boolean }>;
  close: () => Promise<void>;
};

/** The helper pins one kernel process handle before the parent publishes its
 * intent. It permits one normal SIGTERM, never escalates and joins on close. */
export async function pinOwnedHost(target: RetirementTarget, signal: AbortSignal): Promise<HostSignalHandle> {
  if (process.platform !== "linux" || signal.aborted) throw Error("retirement-handle-unavailable");
  const child = spawn("python3", ["-I", "-S", resolveRuntimeHelper(RUNTIME_HELPER_OWNED_HOST_RETIREMENT)], {
    stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
  });
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => undefined);
  let pinned = false, requested = false, signaled = false, exitObserved = false, failed = false, buffer = "";
  const fail = () => { failed = true; readyReject(Error("retirement-handle-unavailable")); child.stdin.end(); };
  child.on("error", fail); child.stdin.on("error", fail);
  const joined = new Promise<void>(resolve => child.once("close", () => { readyReject(Error("retirement-handle-closed")); resolve(); }));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > 4096) { fail(); return; }
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try {
        const row = JSON.parse(line);
        if (row.pid !== target.pid || row.start !== target.start || failed) throw Error();
        if (row.event === "pinned" && !pinned && !requested) { pinned = true; readyResolve(); }
        else if (row.event === "signaled" && requested && !signaled) signaled = true;
        else if (row.event === "exit-observed" && signaled && !exitObserved) exitObserved = true;
        else if (row.event !== "exit-unproven" || !signaled) throw Error();
      } catch { fail(); }
    }
  });
  const abort = () => { fail(); child.kill("SIGTERM"); };
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 3000);
  child.stdin.write(`${JSON.stringify(target)}\n`);
  const close = async () => { child.stdin.end(); await joined; signal.removeEventListener("abort", abort); clearTimeout(timer); };
  try { await ready; clearTimeout(timer); signal.throwIfAborted(); }
  catch (error) { await close(); throw error; }
  return {
    terminate: async () => {
      if (requested || failed || signal.aborted) throw Error("retirement-handle-unavailable");
      requested = true; child.stdin.write("terminate\n"); await joined;
      return { signaled, exitObserved: exitObserved && !failed };
    },
    close,
  };
}
