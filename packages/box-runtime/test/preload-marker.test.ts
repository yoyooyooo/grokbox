import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileFromSource } from "../src/internal/host/profile.ts";
import { expectedCompileReceipt, profileBytes } from "../src/internal/host/compile-receipt.ts";
import { pinLaunchProfile } from "../src/internal/process/profile.node.ts";
import type { IdentityMarker } from "../src/internal/process/identity-op.ts";
import { inspectPid } from "../src/internal/process/linux.node.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const PRELOAD_SRC = fileURLToPath(new URL("../src/preload.ts", import.meta.url));
const NODE = existsSync("/exec-daemon/node") ? "/exec-daemon/node" : (Bun.which("node") ?? process.execPath);
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
    const profile = profileFromSource(runningHost, SYNTHETIC_SLICES);
    await writeFile(profilePath, profileBytes(profile));
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
    let marker: IdentityMarker | null = null;
    while (Date.now() - start < 5000) {
      try {
        marker = JSON.parse(await readFile(markerPath, "utf8")) as IdentityMarker;
        if (marker?.compiled) break;
      } catch {
        /* not yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const childStart = child.pid ? inspectPid(child.pid)?.start : undefined;
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
    expect(marker?.start).toBe(childStart);
    expect(marker?.compile).toEqual(expectedCompileReceipt(profile));
  }, 10_000);

  test.each(["source-mismatch", "syntax-error", "compile-throws"])("%s records a bounded negative observation but never a positive compiled receipt", async (fault) => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-preload-refuse-"));
    const copyPath = join(dir, "host-main.cjs");
    const markerPath = join(dir, "marker.json");
    const preloadPath = join(dir, "preload.cjs");
    const source = `${SYNTHETIC_HOST}\n${fault === "syntax-error" ? "const = ;" : fault === "compile-throws" ? 'throw new Error("synthetic compile failure");' : ""}\n`;
    const profile = profileFromSource(source, SYNTHETIC_SLICES);
    await writeFile(copyPath, fault === "source-mismatch" ? `${source}\n// changed` : source);
    const profilePath = await pinLaunchProfile(dir, profile);
    const built = Bun.spawn(["bun", "build", PRELOAD_SRC, "--outfile", preloadPath, "--target", "node", "--format", "cjs"],
      { stdout: "pipe", stderr: "pipe" });
    expect(await built.exited).toBe(0);
    const child = Bun.spawn([NODE, copyPath], { env: {
      ...process.env, NODE_OPTIONS: `--require=${preloadPath}`, GROKBOX_HOST_BUNDLE: copyPath,
      GROKBOX_PATCH_PROFILE: profilePath, GROKBOX_PRELOAD_MARKER: markerPath,
      GROKBOX_PRELOAD_MODE: "identity", GROKBOX_OPERATION_ID: "negative-compile",
    }, stdout: "pipe", stderr: "pipe" });
    const exit = await child.exited;
    if (fault !== "source-mismatch") expect(exit).not.toBe(0);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    expect(marker.compiled).toBe(false);
    expect(marker.compilationObservation).toMatchObject({ nativeCompilation: fault === "source-mismatch" ? "returned" : "threw",
      code: fault === "source-mismatch" ? "unknown-sha" : "native-compile-failed" });
    expect(JSON.stringify(marker)).not.toContain("synthetic compile failure");
  });
});
