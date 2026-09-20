import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { hostHealthFixture } from "./host-health-fixture.ts";
type Fixture = Awaited<ReturnType<typeof hostHealthFixture>>;

export async function stopPublicHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { await closed; } finally { clearTimeout(timer); }
}
export async function preparePublicHost(f: Fixture, extra = "setInterval(() => {}, 1000);"): Promise<string> {
  const source = f.source + "\n" + extra + "\n";
  await writeFile(f.paths.source, source, { mode: 0o600 });
  await f.writeProfile(source);
  return source;
}
/** Executes ONLY the independently authored public fixture. No real Host,
 * account, native Gateway or provider is consulted by these disposable nodes. */
export async function launchPublicHost(f: Fixture) {
  const runRoot = f.ports.runtime!.runRoot!, marker = join(runRoot, "state/preload-marker.json");
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [f.paths.source], {
    env: { PATH: process.env.PATH, HOME: f.root,
      NODE_OPTIONS: `--require=${join(dirname(process.env.GROKBOX_TEST_CLI_ENTRY!), "preload.cjs")}`,
      GROKBOX_HOST_BUNDLE: f.paths.source, GROKBOX_PATCH_PROFILE: f.paths.profile,
      GROKBOX_PRELOAD_MARKER: marker, GROKBOX_PRELOAD_MODE: "identity", GROKBOX_OPERATION_ID: randomUUID(),
      GROKBOX_BOX_RUNTIME_ROOT: f.root, GROKBOX_RUN_ROOT: runRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", bytes => { output = (output + bytes.toString()).slice(-4096); });
  child.stderr!.on("data", () => undefined);
  try {
    const end = Date.now() + 8000;
    do {
      try {
        const result = JSON.parse(await readFile(marker, "utf8"));
        if (result.pid === child.pid) return { child, marker, result, output: () => output };
      } catch { /* A still-running preload has not published its marker yet. */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < end);
    throw Error("public_host_marker_unavailable");
  } catch (error) { await stopPublicHost(child); throw error; }
}
