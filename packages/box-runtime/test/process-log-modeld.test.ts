import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchPackedRuntime, processDeadline, closePackedRuntime } from "./fixtures/packed-runtime-process.ts";
import { replaceModeld } from "../src/internal/roots/modeld-replace.node.ts";
import { probeModeldIdentity } from "../src/internal/wire/modeld-probe.node.ts";
import { observeProcessLogStorage } from "../src/internal/io/bounded-process-log.node.ts";

const entry = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));
async function logBytes(runRoot: string) {
  const dir = join(runRoot, "log", "process");
  const names = (await readdir(dir)).sort();
  return Promise.all(names.map(async name => [name, await readFile(join(dir, name), "utf8")]));
}

test("actual Node owner writes bounded lifecycle records; a CLI borrower neither rotates nor edits them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "node-modeld-process-log-")), runRoot = join(dir, "run");
  const owner = launchPackedRuntime(dir, ["modeld", "run"]);
  let borrower: ReturnType<typeof launchPackedRuntime> | undefined;
  try {
    expect(await processDeadline(owner.ready)).toMatchObject({ data: { kind: "owned", processLog: { state: "available", writtenRecords: 1 } } });
    const before = await logBytes(runRoot);
    borrower = launchPackedRuntime(dir, ["modeld", "run"]);
    expect(await processDeadline(borrower.ready)).toMatchObject({ data: { kind: "borrowed" } });
    expect((await processDeadline(borrower.exit)).code).toBe(0); expect(await logBytes(runRoot)).toEqual(before);
    await closePackedRuntime(owner);
    const after = JSON.stringify(await logBytes(runRoot));
    expect(after).toContain("shutdown_requested"); expect(after).not.toContain("listener_failed");
    expect(existsSync(join(runRoot, "modeld.sock"))).toBe(false);
  } finally {
    if (borrower) await closePackedRuntime(borrower);
    await closePackedRuntime(owner); await rm(dir, { recursive: true, force: true });
  }
}, 15000);

test.skipIf(process.platform !== "linux")("actual modeld replacement does not inherit an unbounded log fd and leaves old raw logs untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "node-modeld-log-replace-"));
  const runRoot = join(dir, "run"), durableRoot = join(dir, "durable");
  await mkdir(runRoot, { mode: 0o700 }); await mkdir(join(runRoot, "log"), { mode: 0o700 });
  const legacyPath = join(runRoot, "log", "modeld-process.log"); await writeFile(legacyPath, "OLD_RAW_DO_NOT_MODIFY");
  const owner = launchPackedRuntime(dir, ["modeld", "run"], durableRoot);
  let replacement: { pid: number; serviceEpoch: string } | undefined;
  try {
    const original = await processDeadline(owner.ready);
    const result = await replaceModeld({ durableRoot, runRoot, expectedEpoch: original.data.generation, entry,
      noManagedBotsRunning: true, confirmed: true,
      env: { PATH: process.env.PATH, HOME: dir, LANG: "C.UTF-8", GROKBOX_CONFIG_DIR: join(dir, "config") } });
    replacement = result;
    expect(result).toMatchObject({ replaced: true, hostRestarted: false, oldRequestsReplayed: false });
    expect((await processDeadline(owner.exit)).code).toBe(0);
    expect((await probeModeldIdentity(runRoot, 1000))?.generation).toBe(result.serviceEpoch);
    expect(await readlink(`/proc/${result.pid}/fd/1`)).toBe("/dev/null");
    expect(await readlink(`/proc/${result.pid}/fd/2`)).toBe("/dev/null");
    const usage = await observeProcessLogStorage(runRoot);
    expect(usage.state).toBe("available"); expect(usage.segments).toHaveLength(2);
    expect(await readFile(legacyPath, "utf8")).toBe("OLD_RAW_DO_NOT_MODIFY");
  } finally {
    await closePackedRuntime(owner);
    if (replacement) {
      const current = await probeModeldIdentity(runRoot, 500);
      // The exact returned fixture service is the only signal target. No Host,
      // production socket, global PID search or unrelated process is touched.
      if (current?.generation === replacement.serviceEpoch) process.kill(replacement.pid, "SIGTERM");
      await processDeadline((async () => {
        while (existsSync(join(runRoot, "modeld.sock"))) await new Promise(resolve => setTimeout(resolve, 20));
      })(), 5000);
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
