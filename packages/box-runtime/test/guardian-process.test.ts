import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPid } from "../src/live-proc.ts";
import { spawnIndependentGuardian } from "../src/guardian-process.ts";

const CHILD = fileURLToPath(new URL("../src/guardian-child.cjs", import.meta.url));
const NODE = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;
const describeLinux = existsSync("/proc/self/stat") ? describe : describe.skip;

function stateOf(pid: number): string | null {
  try {
    const status = require("node:fs").readFileSync(`/proc/${pid}/status`, "utf8") as string;
    return status.split("State:")[1]?.trim()[0] ?? null;
  } catch {
    return null;
  }
}

async function waitUntil(pred: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pred();
}

describeLinux("independent guardian subprocess", () => {
  test("handshake before STOP; injector SIGKILL CONTs exact identity; no TERM/KILL in child", async () => {
    const victim = spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (victim.pid == null) throw new Error("no victim");
    expect(await waitUntil(() => inspectPid(victim.pid!) !== null)).toBe(true);
    const ident = inspectPid(victim.pid);
    expect(ident).toBeTruthy();

    const dir = await mkdtemp(join(tmpdir(), "grokbox-g-"));
    const guardian = await spawnIndependentGuardian({
      frozen: [ident!],
      deadlineMs: 8000,
      stateDir: dir,
      execPath: NODE,
    });
    expect(guardian.armed).toBe(true);

    process.kill(victim.pid, "SIGSTOP");
    expect(await waitUntil(() => stateOf(victim.pid!) === "T")).toBe(true);
    guardian.killInjector();
    expect(await waitUntil(() => stateOf(victim.pid!) !== "T", 6000)).toBe(true);
    expect(inspectPid(victim.pid)?.start).toBe(ident!.start);
    expect(inspectPid(victim.pid)?.uid).toBe(ident!.uid);
    process.kill(victim.pid, "SIGTERM");
    const childSrc = await readFile(CHILD, "utf8");
    expect(childSrc).not.toMatch(/SIGTERM|SIGKILL/);
    expect(childSrc).toContain("SIGCONT");
    expect(childSrc).toContain("sameIdentity");
  }, 15_000);
});
