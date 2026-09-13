import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPid } from "../src/internal/process/linux.node.ts";
import { spawnIndependentGuardian, type IndependentGuardian } from "../src/internal/process/guardian-process.ts";

const CHILD = fileURLToPath(new URL("../src/internal/process/helpers/guardian-child.cjs", import.meta.url));
const NODE = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;
const describeLinux = existsSync("/proc/self/stat") ? describe : describe.skip;

function stateOf(pid: number): string | null {
  try { return readFileSync(`/proc/${pid}/status`, "utf8").split("State:")[1]?.trim()[0] ?? null; }
  catch { return null; }
}
async function waitUntil(pred: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return pred();
}

describeLinux("independent guardian subprocess", () => {
  test("handshake before STOP; injector SIGKILL CONTs exact identity; no TERM/KILL in child", async () => {
    const victim = spawn(NODE, ["-e", "process.stdout.write('OWNED_VICTIM_READY\\n'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "ignore"] });
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      let text = "";
      const timer = setTimeout(() => rejectReady(new Error("owned victim startup timeout")), 2000);
      victim.stdout?.on("data", (chunk: Buffer) => {
        text = (text + chunk.toString()).slice(-128);
        if (text.includes("OWNED_VICTIM_READY\n")) { clearTimeout(timer); resolveReady(); }
      });
      victim.once("error", error => { clearTimeout(timer); rejectReady(error); });
      victim.once("exit", () => { clearTimeout(timer); rejectReady(new Error("owned victim exited before ready")); });
    });
    const exited = new Promise<void>((resolveExit, rejectExit) => {
      victim.once("exit", () => resolveExit());
      victim.once("error", rejectExit);
    });
    void exited.catch(() => undefined);
    let guardian: IndependentGuardian | undefined;
    let dir: string | undefined;
    try {
      if (victim.pid == null) throw new Error("no owned victim");
      // /proc existence is not an exec-complete handshake: capturing a transient
      // launcher's argv/exe can cause the strict guardian to correctly refuse it.
      await ready;
      const ident = inspectPid(victim.pid);
      expect(ident).toBeTruthy();
      dir = await mkdtemp(join(tmpdir(), "grokbox-g-"));
      guardian = await spawnIndependentGuardian({ frozen: [ident!], deadlineMs: 8000, stateDir: dir, execPath: NODE });
      expect(guardian.armed).toBe(true);
      process.kill(victim.pid, "SIGSTOP");
      expect(await waitUntil(() => stateOf(victim.pid!) === "T")).toBe(true);
      guardian.killInjector();
      const resumed = await waitUntil(() => stateOf(victim.pid!) !== "T", 6000);
      const after = inspectPid(victim.pid);
      // Preserve why exact-identity recovery refused; synthetic process metadata only.
      const fields = ["pid", "start", "uid", "ppid", "exe", "cmdline"] as const;
      const mismatched = fields.filter(field => JSON.stringify(ident?.[field]) !== JSON.stringify(after?.[field]));
      expect(resumed, JSON.stringify({ victimPid: victim.pid, state: stateOf(victim.pid), mismatched,
        injectorState: guardian.injectorPid ? stateOf(guardian.injectorPid) : null })).toBe(true);
      expect(after?.start).toBe(ident!.start);
      expect(after?.uid).toBe(ident!.uid);
      const childSrc = await readFile(CHILD, "utf8");
      expect(childSrc).not.toMatch(/SIGTERM|SIGKILL/);
      expect(childSrc).toContain("SIGCONT");
      expect(childSrc).toContain("sameIdentity");
    } finally {
      // Only the exact ChildProcess created here, never a process census/PID glob.
      // Test failure is not permission to leave an owned fixture stopped forever.
      guardian?.release();
      if (victim.exitCode === null && victim.signalCode === null) {
        victim.kill("SIGCONT");
        victim.kill("SIGTERM");
        if (!await waitUntil(() => victim.exitCode !== null || victim.signalCode !== null, 1500)) victim.kill("SIGKILL");
      }
      await exited;
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
