import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runIdentityDeactivate, runIdentityOperation } from "../src/identity-op.ts";
import { inspectPid, linuxProcessPort } from "../src/live-proc.ts";
import { armGuardian } from "../src/guardian.ts";
import type { PatchProfile } from "../src/transform.ts";
import { hangUntilAbort } from "./fake-tree.ts";

const WRAPPER = fileURLToPath(new URL("./fixtures/disposable-wrapper.cjs", import.meta.url));
const SUPERVISOR = fileURLToPath(new URL("./fixtures/disposable-supervisor.cjs", import.meta.url));
const HOST = fileURLToPath(new URL("./fixtures/disposable-host.cjs", import.meta.url));
const describeLinux = existsSync("/proc/self/stat") ? describe : describe.skip;
const NODE = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;

const reviewed: PatchProfile = {
  profileId: "reviewed",
  sourceSha256: "sha-reviewed",
  transformedSourceSha256: "sha-x",
  slices: [
    { id: "create-session", startAnchor: "a", endAnchor: "b", find: "c", replacement: "d" },
    { id: "agent-id", startAnchor: "e", endAnchor: "f", find: "g", replacement: "h" },
  ],
};

function classify(ident: { cmdline: readonly string[] }) {
  const line = ident.cmdline.join(" ");
  if (line.includes("disposable-wrapper.cjs")) return "wrapper" as const;
  if (line.includes("disposable-supervisor.cjs")) return "supervisor" as const;
  if (line.includes("disposable-host.cjs")) return "host" as const;
  return null;
}

async function waitUntil(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pred();
}

describeLinux("disposable Linux supervisor tree", () => {
  test("old host exits, supervisor-owned replacement, /proc identity, deactivate to a different host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-linux-"));
    const pidFile = join(dir, "host.pid");
    const wrapperProc: ChildProcess = spawn(NODE, [WRAPPER, SUPERVISOR, HOST, pidFile], {
      stdio: "ignore",
    });
    const killTree = async () => {
      try {
        if (wrapperProc.pid) process.kill(wrapperProc.pid, "SIGTERM");
      } catch {
        /* ignore */
      }
      for (const ident of linuxProcessPort().list()) {
        const role = classify(ident);
        if (role) {
          try {
            process.kill(ident.pid, "SIGTERM");
          } catch {
            /* ignore */
          }
        }
      }
    };
    try {
      const port = linuxProcessPort();
      expect(
        await waitUntil(() => {
          const roles = port.list().map(classify).filter(Boolean);
          return roles.includes("wrapper") && roles.includes("supervisor") && roles.includes("host");
        }),
      ).toBe(true);
      const firstHost = port.list().find((ident) => classify(ident) === "host");
      expect(firstHost).toBeTruthy();
      const firstPid = firstHost!.pid;

      const result = await runIdentityOperation({
        processes: port,
        classify,
        reviewedProfile: reviewed,
        diskSha: () => "sha-reviewed",
        ephemeralRoot: dir,
        operationId: "linux-op",
        readMarker: () => null,
        waitHostGone: async (old) => await waitUntil(() => inspectPid(old.pid)?.start !== old.start),
        supervisorRelaunch: async () => {
          expect(
            await waitUntil(async () => {
              const text = await readFile(pidFile, "utf8").catch(() => "");
              const pid = Number(text.trim());
              return pid > 0 && pid !== firstPid && inspectPid(pid) !== null;
            }, 6000),
          ).toBe(true);
          const pid = Number((await readFile(pidFile, "utf8")).trim());
          return inspectPid(pid);
        },
        waitReady: async (pid) => ({
          operationId: "linux-op",
          pid,
          mode: "identity",
          transformed: true,
          compiled: true,
          modeld: false,
        }),
        armGuardian: (frozen) => {
          const g = armGuardian({
            wrapper: frozen[0]!,
            processes: port,
            deadlineMs: 8000,
            now: () => Date.now(),
            wait: hangUntilAbort(),
          });
          return { release: () => g.close() };
        },
        now: () => Date.now(),
      });
      expect(result.code ?? "ok").toBe("ok");
      expect(result.ok).toBe(true);
      expect(result.host?.pid).not.toBe(firstPid);
      expect(inspectPid(result.host!.pid)?.ppid).toBe(result.host?.ppid);

      let cleared = false;
      const deactivated = await runIdentityDeactivate({
        processes: port,
        classify,
        diskSha: () => "sha-reviewed",
        attestation: { identity: result.host!, diskSha: "sha-reviewed" },
        waitHostGone: async (old) => await waitUntil(() => inspectPid(old.pid)?.start !== old.start),
        waitReplacement: async (oldPid) => {
          await waitUntil(() => {
            const host = linuxProcessPort().list().find((ident) => classify(ident) === "host");
            return Boolean(host && host.pid !== oldPid);
          }, 6000);
          return linuxProcessPort().list().find((ident) => classify(ident) === "host") ?? null;
        },
        hasGrokboxPreload: () => false,
        clearAttestation: async () => {
          cleared = true;
        },
      });
      expect(deactivated.ok).toBe(true);
      expect(cleared).toBe(true);
      expect(deactivated.host?.pid).not.toBe(result.host?.pid);
    } finally {
      await killTree();
    }
  }, 20_000);
});
