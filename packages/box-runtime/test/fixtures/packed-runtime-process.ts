import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../../../../dist/index.js", import.meta.url));
export type PackedRuntimeCommand = ["modeld", "run"] | ["start", "--mode", "observe" | "identity" | "route"];
type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

/** A disposable Node process with an empty, explicitly scoped environment. It
 * never inherits production credentials, live preload options or discovery. */
export function launchPackedRuntime(dir: string, command: PackedRuntimeCommand, durableRoot = join(dir, "durable")) {
  const child: ChildProcessWithoutNullStreams = spawn("node", [entry, "runtime", ...command, "--json"], {
    cwd: dir, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: dir, LANG: "C.UTF-8",
      GROKBOX_CONFIG_DIR: join(dir, "config"), GROKBOX_BOX_RUNTIME_ROOT: durableRoot,
      GROKBOX_RUN_ROOT: join(dir, "run") },
  });
  child.stdin.end();
  let stdout = "", stderr = "", buffered = "", readySeen = false;
  let resolveReady!: (value: Record<string, any>) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<Record<string, any>>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  const exit = new Promise<ChildExit>((resolve, reject) => {
    child.once("error", error => { rejectReady(error); reject(error); });
    child.once("exit", (code, signal) => {
      if (!readySeen) rejectReady(new Error(`owned Node runtime exited before readiness: ${code}; ${stderr}`));
      resolve({ code, signal });
    });
  });
  void exit.catch(() => undefined);
  child.stdout.on("data", chunk => {
    stdout += chunk.toString();
    buffered += chunk.toString();
    if (stdout.length > 64 * 1024) { rejectReady(new Error("owned_stdout_bound")); child.kill("SIGTERM"); return; }
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.data?.process === (command[0] === "start" ? "start" : "modeld")) {
          readySeen = true; resolveReady(row);
        }
      } catch { rejectReady(new Error("owned_invalid_stdout_json")); }
    }
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
  return { child, ready, exit, output: () => ({ stdout, stderr }) };
}

export async function processDeadline<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("owned_process_deadline")), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function closePackedRuntime(runtime: ReturnType<typeof launchPackedRuntime>): Promise<ChildExit> {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill("SIGTERM");
  try { return await processDeadline(runtime.exit); }
  catch (error) {
    // Only this test's child is eligible. Production process signals are never used.
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill("SIGKILL");
    await runtime.exit;
    throw error;
  }
}
