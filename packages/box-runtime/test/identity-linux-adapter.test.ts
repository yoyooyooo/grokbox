import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAttestation } from "../src/internal/io/authority.node.ts";
import { attestationAgrees } from "../src/internal/process/identity-op.ts";
import { runH3OfflineDeactivate, runH3OfflineInject } from "../src/internal/process/h3-identity.ts";
import { inspectPid, linuxProcessPort, readEnviron } from "../src/internal/process/linux.node.ts";
import { profileFromSource } from "../src/internal/host/profile.ts";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const WRAPPER = fileURLToPath(new URL("./fixtures/disposable-wrapper.cjs", import.meta.url));
const SUPERVISOR = fileURLToPath(new URL("./fixtures/disposable-supervisor.cjs", import.meta.url));
const HOST = fileURLToPath(new URL("./fixtures/disposable-host.cjs", import.meta.url));
const PRELOAD_SRC = fileURLToPath(new URL("../src/preload.ts", import.meta.url));
const describeLinux = existsSync("/proc/self/stat") ? describe : describe.skip;
const NODE = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;
const FORBIDDEN = "sk-forbidden-acme";

function classifyFor(dir: string) {
  return (ident: { cmdline: readonly string[] }) => {
    const line = ident.cmdline.join(" ");
    if (line.includes("/home/box/sand-host/host-main.cjs")) return null;
    if (line.includes("disposable-wrapper.cjs")) return "wrapper" as const;
    if (line.includes("disposable-supervisor.cjs")) return "supervisor" as const;
    if (line.includes("disposable-host.cjs")) return "host" as const;
    if (line.includes(dir) && line.includes("host-main.cjs")) return "host" as const;
    return null;
  };
}

async function waitUntil(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pred();
}

function hasPreload(ident: { pid: number }, needle: string): boolean {
  try {
    return (readEnviron(ident.pid).NODE_OPTIONS ?? "").includes(needle);
  } catch {
    return false;
  }
}

function hasForbidden(ident: { pid: number }): boolean {
  try {
    const env = readEnviron(ident.pid);
    return env.ACME_KEY === FORBIDDEN || Object.values(env).includes(FORBIDDEN);
  } catch {
    return false;
  }
}

describeLinux("disposable Linux supervisor tree", () => {
  test("allowlisted launch, committed attestation, SHA drift cannot attest, deactivate uses record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-linux-"));
    const pidFile = join(dir, "host.pid");
    const specFile = join(dir, "launch.json");
    const copyPath = join(dir, "host-main.cjs");
    const profilePath = join(dir, "reviewed.json");
    const markerPath = join(dir, "marker.json");
    const preloadPath = join(dir, "preload.cjs");
    const runningHost = `${SYNTHETIC_HOST}\nsetInterval(() => {}, 1000);\n`;
    await writeFile(copyPath, runningHost);
    const profile = profileFromSource(runningHost, SYNTHETIC_SLICES, "reviewed-copy");
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    await writeFile(specFile, `${JSON.stringify({ argv: [HOST] })}\n`);
    const built = Bun.spawn(
      ["bun", "build", PRELOAD_SRC, "--outfile", preloadPath, "--target", "node", "--format", "cjs"],
      { cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdout: "pipe", stderr: "pipe" },
    );
    expect(await built.exited).toBe(0);

    const wrapperProc: ChildProcess = spawn(NODE, [WRAPPER, SUPERVISOR, HOST, pidFile, specFile], {
      stdio: "ignore",
      env: { ...process.env, ACME_KEY: FORBIDDEN },
    });
    const classify = classifyFor(dir);
    const killTree = async () => {
      try {
        if (wrapperProc.pid) process.kill(wrapperProc.pid, "SIGTERM");
      } catch {
        /* ignore */
      }
      for (const ident of linuxProcessPort().list()) {
        if (classify(ident)) {
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
      const firstPid = port.list().find((ident) => classify(ident) === "host")!.pid;
      const operationId = "linux-op";
      const diskSha = () => sha256Bytes(readFileSync(copyPath));
      expect(diskSha()).toBe(profile.sourceSha256);
      let driftOnce = true;

      const ports = {
        processes: port,
        classify,
        waitHostGone: async (old: { pid: number; start: number }) =>
          await waitUntil(() => inspectPid(old.pid)?.start !== old.start),
        supervisorRelaunch: async () => {
          expect(
            await waitUntil(async () => {
              const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
              return pid > 0 && pid !== firstPid && inspectPid(pid) !== null;
            }, 6000),
          ).toBe(true);
          return inspectPid(Number((await readFile(pidFile, "utf8")).trim()));
        },
        waitReady: async (pid: number) => {
          const ready = await waitUntil(async () => {
            try {
              const marker = JSON.parse(await readFile(markerPath, "utf8")) as { pid?: number; compiled?: boolean };
              return marker.pid === pid && marker.compiled === true;
            } catch {
              return false;
            }
          }, 8000);
          if (!ready) return null;
          if (driftOnce) {
            driftOnce = false;
            await writeFile(copyPath, `${runningHost}\n// drift\n`);
          }
          return JSON.parse(await readFile(markerPath, "utf8"));
        },
        applyLaunchEnv: async (env: Record<string, string>) => {
          await writeFile(specFile, `${JSON.stringify({ argv: [copyPath], env, replaceEnv: true })}\n`);
        },
        hasGrokboxPreload: (host: { pid: number }) => hasPreload(host, preloadPath),
      };

      const drifted = await runH3OfflineInject({
        ephemeralRoot: dir,
        reviewedProfilePath: profilePath,
        diskSha,
        operationId,
        execPath: NODE,
        preloadPath,
        hostBundle: copyPath,
        markerPath,
        launchSource: { ...process.env, ACME_KEY: FORBIDDEN, PATH: process.env.PATH, HOME: process.env.HOME },
        ports,
      });
      expect(drifted.ok).toBe(false);
      expect(drifted.code).toBe("disk-sha-changed");
      expect(drifted.coverage).not.toBe("attested");
      expect(await readAttestation(dir)).toBeNull();
      await writeFile(copyPath, runningHost);
      expect(diskSha()).toBe(profile.sourceSha256);

      const result = await runH3OfflineInject({
        ephemeralRoot: dir,
        reviewedProfilePath: profilePath,
        diskSha,
        operationId,
        execPath: NODE,
        preloadPath,
        hostBundle: copyPath,
        markerPath,
        launchSource: { ...process.env, ACME_KEY: FORBIDDEN, PATH: process.env.PATH, HOME: process.env.HOME },
        ports,
      });
      expect(result.code ?? "ok").toBe("ok");
      expect(result.ok).toBe(true);
      expect(result.coverage).toBe("attested");
      expect(result.host?.pid).not.toBe(firstPid);
      expect(hasPreload(result.host!, preloadPath)).toBe(true);
      expect(hasForbidden(result.host!)).toBe(false);
      const record = await readAttestation(dir);
      expect(record).toMatchObject({ mode: "identity", coverage: "attested", modeld: false, diskSha: diskSha() });
      expect(
        attestationAgrees({
          attestation: record,
          liveHost: result.host!,
          diskSha: result.diskShaAfter,
          census: result.census,
        }),
      ).toBe(true);

      await writeFile(specFile, `${JSON.stringify({ argv: [HOST], env: { PATH: process.env.PATH }, replaceEnv: true })}\n`);
      const deactivated = await runH3OfflineDeactivate({
        ephemeralRoot: dir,
        diskSha,
        ports,
      });
      expect(deactivated.code ?? "ok").toBe("ok");
      expect(deactivated.ok).toBe(true);
      expect(deactivated.host?.pid).not.toBe(result.host?.pid);
      expect(hasPreload(deactivated.host!, preloadPath)).toBe(false);
      expect(await readAttestation(dir)).toBeNull();
    } finally {
      await killTree();
    }
  }, 25_000);
});
