import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, readdir, mkdir, symlink } from "node:fs/promises";
import { observeProcessLogStorage } from "../src/internal/io/bounded-process-log.node.ts";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";

async function settled(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => ({ kind: "resolved" as const }), error => ({ kind: "rejected" as const, error })),
      new Promise<{ kind: "hung" }>(resolve => { timer = setTimeout(() => resolve({ kind: "hung" }), 750); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

for (const failure of ["close", "error"] as const) {
  test(`a ready modeld losing its listener (${failure}) settles its owner after cleanup instead of staying alive`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbox-running-loss-"));
    const counts = { listeners: 0, sockets: 0, fibers: 0 };
    let listener: Server | undefined;
    const started = await startModeldProcess({ durableRoot: dir, runRoot: dir, env: {}, counts,
      hooks: { onAllocated: value => { listener = value; } } });
    try {
      expect(listener?.listening).toBe(true);
      expect(started.ensure).toMatchObject({ kind: "owned", processLog: { state: "available", writtenRecords: 1 } });
      // The old facade had no completed lifetime, so the command could only
      // wait for a future user signal. This fallback makes that defect bounded.
      const completed = (started as typeof started & { finished?: Promise<void> }).finished ?? new Promise<void>(() => {});
      if (failure === "close") listener!.close();
      else listener!.emit("error", new Error("PRIVATE_SOCKET_DETAIL"));
      const result = await settled(completed);
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.error.message).toBe(failure === "close" ? "modeld_listener_closed" : "modeld_listener_error");
        expect(String(result.error)).not.toContain("PRIVATE_SOCKET_DETAIL");
      }
      expect(counts).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
      expect(existsSync(join(dir, "modeld.sock"))).toBe(false);
      const files = await readdir(join(dir, "log", "process"));
      const text = (await Promise.all(files.map(name => readFile(join(dir, "log", "process", name), "utf8")))).join("");
      expect(text).toContain('"event":"listener_failed"'); expect(text).not.toContain("PRIVATE_SOCKET_DETAIL");
    } finally { await started.stop(); await rm(dir, { recursive: true, force: true }); }
  }, 4000);
}

test("normal cancellation settles the owned lifetime without misreporting its deliberate listener close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-running-cancel-"));
  const controller = new AbortController();
  const started = await startModeldProcess({ durableRoot: dir, runRoot: dir, env: {}, signal: controller.signal });
  try {
    const completed = (started as typeof started & { finished?: Promise<void> }).finished ?? new Promise<void>(() => {});
    controller.abort();
    expect((await settled(completed)).kind).toBe("resolved");
    expect(existsSync(join(dir, "modeld.sock"))).toBe(false);
    const usage = await observeProcessLogStorage(dir); expect(usage.state).toBe("available");
    const text = (await Promise.all((await readdir(join(dir, "log", "process"))).map(name => readFile(join(dir, "log", "process", name), "utf8")))).join("");
    expect(text).toContain('"event":"shutdown_requested"'); expect(text).not.toContain('"event":"listener_failed"');
  } finally { await started.stop(); await rm(dir, { recursive: true, force: true }); }
}, 4000);

test("an unsafe diagnostic directory does not prevent modeld ownership or write through the symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-log-unavailable-"));
  const elsewhere = join(dir, "not-a-log-directory"); await mkdir(elsewhere);
  await symlink(elsewhere, join(dir, "log"));
  const started = await startModeldProcess({ durableRoot: dir, runRoot: dir, env: {} });
  try {
    expect(started.ensure).toMatchObject({ kind: "owned", processLog: { state: "unavailable", reason: "storage_unavailable" } });
    expect(await readdir(elsewhere)).toEqual([]); expect(existsSync(join(dir, "modeld.sock"))).toBe(true);
  } finally { await started.stop(); await rm(dir, { recursive: true, force: true }); }
}, 4000);
