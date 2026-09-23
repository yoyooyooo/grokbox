import { spawn } from "node:child_process";

/** Parent signals cancel the current invocation; the caller joins it before
 * disposal and never starts another shard after cancellation. */
export function verificationSignals() {
  const controller = new AbortController();
  const handlers = ["SIGTERM", "SIGINT", "SIGHUP"].map(name => {
    const fn = () => controller.abort(name); process.on(name, fn); return [name, fn];
  });
  return { signal: controller.signal, dispose() { for (const [name, fn] of handlers) process.off(name, fn); } };
}

/** The caller owns only this spawned child handle, not any machine PID list.
 * A child result is accepted at close (including its stdio), never at exit or
 * first output. Test programs retain ownership of their own worker teardown. */
export function verificationChild(command, { cwd, env = process.env, signal, timeoutMs = 180000,
  maxOutputBytes = 12 * 1024 * 1024, graceMs = 1000, onOutput } = {}) {
  if (!Array.isArray(command) || !command.length || command.some(x => typeof x !== "string" || !x || x.includes("\0"))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(graceMs) || graceMs < 1
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw Error("invalid-verification-child");
  if (signal?.aborted) return Promise.resolve({ status: null, signal: null, error: { code: "ABORTED" }, settled: true, stdout: "", stderr: "", elapsedMs: 0 });
  return new Promise(resolve => {
    const started = performance.now(), stdout = [], stderr = [];
    let size = 0, error = null, finished = false, killTimer, cleanupTimer;
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (status, exitSignal, settled) => {
      if (finished) return; finished = true;
      clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", abort);
      if (!settled) { child.stdout.destroy(); child.stderr.destroy(); }
      resolve({ status, signal: exitSignal, error, settled, stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"), outputBytes: size, elapsedMs: Math.round(performance.now() - started) });
    };
    const stop = code => {
      error ??= { code };
      if (finished) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => { if (!finished) child.kill("SIGKILL"); }, graceMs);
      cleanupTimer ??= setTimeout(() => { if (!finished) { error = { code: "CLEANUP_UNCONFIRMED", cause: error.code }; finish(null, null, false); } }, graceMs + 5000);
    };
    const abort = () => stop("ABORTED");
    const deadline = setTimeout(() => stop("ETIMEDOUT"), timeoutMs);
    const capture = (chunks, bytes) => {
      size += bytes.length;
      if (size > maxOutputBytes) { stop("OUTPUT_LIMIT"); return; }
      chunks.push(Buffer.from(bytes));
      try { onOutput?.(bytes.toString("utf8")); } catch { stop("OUTPUT_OBSERVER_FAILED"); }
    };
    child.stdout.on("data", bytes => capture(stdout, bytes)); child.stderr.on("data", bytes => capture(stderr, bytes));
    child.once("error", e => { error ??= { code: e.code ?? "SPAWN_FAILED" }; });
    child.once("close", (status, exitSignal) => finish(status, exitSignal, true));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
