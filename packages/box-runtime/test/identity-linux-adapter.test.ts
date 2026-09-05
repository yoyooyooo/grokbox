import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runH3OfflineDeactivate, runH3OfflineInject } from "../src/h3-identity.ts";
import { inspectPid, linuxProcessPort, readEnviron } from "../src/live-proc.ts";
import { profileFromSource } from "../src/transform.ts";
import { sha256Text } from "../src/hash.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const WRAPPER = fileURLToPath(new URL("./fixtures/disposable-wrapper.cjs", import.meta.url));
const SUPERVISOR = fileURLToPath(new URL("./fixtures/disposable-supervisor.cjs", import.meta.url));
const HOST = fileURLToPath(new URL("./fixtures/disposable-host.cjs", import.meta.url));
const PRELOAD_SRC = fileURLToPath(new URL("../src/preload.ts", import.meta.url));
const describeLinux = existsSync("/proc/self/stat") ? describe : describe.skip;
const NODE = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;

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
    const env = readEnviron(ident.pid);
    return (env.NODE_OPTIONS ?? "").includes(needle);
  } catch {
    return false;
  }
}

describeLinux("disposable Linux supervisor tree", () => {
  test("independent guardian, real preload marker, unpatched deactivate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-linux-"));
    const pidFile = join(dir, "host.pid");
    const specFile = join(dir, "launch.json");
    const copyPath = join(dir, "host-main.cjs");
    const profilePath = join(dir, "reviewed.json");
    const markerPath = join(dir, "marker.json");
    const preloadPath = join(dir, "preload.cjs");
    const runningHost = `${SYNTHETIC_HOST}
setInterval(() => {}, 1000);
`;
    await writeFile(copyPath, runningHost);
    const sha = sha256Text(runningHost);
    const profile = profileFromSource(runningHost, SYNTHETIC_SLICES, "reviewed-copy");
    expect(profile.sourceSha256).toBe(sha);
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    await writeFile(specFile, `${JSON.stringify({ argv: [HOST] })}\n`);
    const built = Bun.spawn(["bun", "build", PRELOAD_SRC, "--outfile", preloadPath, "--target", "node", "--format", "cjs"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await built.exited).toBe(0);

    const wrapperProc: ChildProcess = spawn(NODE, [WRAPPER, SUPERVISOR, HOST, pidFile, specFile], {
      stdio: "ignore",
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
      const firstHost = port.list().find((ident) => classify(ident) === "host");
      expect(firstHost).toBeTruthy();
      const firstPid = firstHost!.pid;
      const operationId = "linux-op";

      const ports = {
        processes: port,
        classify,
        waitHostGone: async (old: { pid: number; start: number }) =>
          await waitUntil(() => inspectPid(old.pid)?.start !== old.start),
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
          return JSON.parse(await readFile(markerPath, "utf8"));
        },
        prepareReplacement: async () => {
          await writeFile(
            specFile,
            `${JSON.stringify({
              argv: [copyPath],
              env: {
                NODE_OPTIONS: `--require=${preloadPath}`,
                GROKBOX_HOST_BUNDLE: copyPath,
                GROKBOX_PATCH_PROFILE: profilePath,
                GROKBOX_PRELOAD_MARKER: markerPath,
                GROKBOX_PRELOAD_MODE: "identity",
                GROKBOX_OPERATION_ID: operationId,
              },
            })}\n`,
          );
        },
        hasGrokboxPreload: (host: { pid: number }) => hasPreload(host, preloadPath),
        persistAttestation: async () => undefined,
        clearAttestation: async () => undefined,
      };

      const result = await runH3OfflineInject({
        ephemeralRoot: dir,
        reviewedProfilePath: profilePath,
        observedSha: sha,
        operationId,
        execPath: NODE,
        ports,
      });
      expect(result.code ?? "ok").toBe("ok");
      expect(result.ok).toBe(true);
      expect(result.host?.pid).not.toBe(firstPid);
      expect(hasPreload(result.host!, preloadPath)).toBe(true);

      await writeFile(specFile, `${JSON.stringify({ argv: [HOST], env: {} })}\n`);
      let cleared = false;
      const deactivated = await runH3OfflineDeactivate({
        ephemeralRoot: dir,
        observedSha: sha,
        attestation: { identity: result.host!, diskSha: sha },
        ports: {
          ...ports,
          clearAttestation: async () => {
            cleared = true;
          },
        },
      });
      expect(deactivated.code ?? "ok").toBe("ok");
      expect(deactivated.ok).toBe(true);
      expect(cleared).toBe(true);
      expect(deactivated.host?.pid).not.toBe(result.host?.pid);
      expect(hasPreload(deactivated.host!, preloadPath)).toBe(false);
    } finally {
      await killTree();
    }
  }, 25_000);
});
