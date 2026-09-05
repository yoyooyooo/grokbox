import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileFromSource } from "../src/transform.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const PRELOAD_SRC = fileURLToPath(new URL("../src/preload.ts", import.meta.url));
const NODE = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : process.execPath;
const describeLinux = existsSync("/proc/self/stat") ? describe : describe.skip;

describeLinux("real preload marker on disposable copy", () => {
  test("writes operation marker only after transformed compile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-preload-"));
    const copyPath = join(dir, "host-main.cjs");
    const profilePath = join(dir, "reviewed.json");
    const markerPath = join(dir, "marker.json");
    const preloadPath = join(dir, "preload.cjs");
    const runningHost = `${SYNTHETIC_HOST}
setInterval(() => {}, 1000);
`;
    await writeFile(copyPath, runningHost);
    await writeFile(profilePath, `${JSON.stringify(profileFromSource(runningHost, SYNTHETIC_SLICES))}\n`);
    const built = Bun.spawn(
      ["bun", "build", PRELOAD_SRC, "--outfile", preloadPath, "--target", "node", "--format", "cjs"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await built.exited).toBe(0);
    const child = spawn(NODE, [copyPath], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${preloadPath}`,
        GROKBOX_HOST_BUNDLE: copyPath,
        GROKBOX_PATCH_PROFILE: profilePath,
        GROKBOX_PRELOAD_MARKER: markerPath,
        GROKBOX_PRELOAD_MODE: "identity",
        GROKBOX_OPERATION_ID: "preload-op",
      },
      stdio: "ignore",
    });
    const start = Date.now();
    type Marker = {
      pid?: number;
      compiled?: boolean;
      operationId?: string;
      transformed?: boolean;
      mode?: string;
      modeld?: boolean;
    };
    let marker: Marker | null = null;
    while (Date.now() - start < 5000) {
      try {
        marker = JSON.parse(await readFile(markerPath, "utf8")) as Marker;
        if (marker?.compiled) break;
      } catch {
        /* not yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      if (child.pid) process.kill(child.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    expect(marker).toMatchObject({
      operationId: "preload-op",
      compiled: true,
      transformed: true,
      mode: "identity",
      modeld: false,
    });
    expect(marker?.pid).toBe(child.pid);
  }, 10_000);
});
