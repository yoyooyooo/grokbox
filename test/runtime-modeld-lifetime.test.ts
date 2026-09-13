import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModeldProcess } from "@grokbox/box-runtime/runtime";
import { captureCli } from "./helpers.ts";

async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(value => ({ kind: "done" as const, value })),
      new Promise<{ kind: "hung" }>(resolve => { timer = setTimeout(() => resolve({ kind: "hung" }), 750); })]);
  } finally { if (timer) clearTimeout(timer); }
}

for (const at of ["after-ready", "while-writing-ready"] as const) {
  test(`foreground modeld uses command signal (${at}) without installing a second signal owner`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbox-cli-modeld-"));
    const controller = new AbortController();
    const initial = new Set(process.listeners("SIGTERM"));
    let releaseReady!: () => void;
    const ready = new Promise<void>(resolve => { releaseReady = resolve; });
    let stdout = "";
    const pending = captureCli(["runtime", "modeld", "run", "--json"], {
      boxRuntimeRoot: dir, configDir: dir, discoveryPath: join(dir, "missing-gateway.json"),
      daemonSocket: join(dir, "missing-daemon.sock"), transport: "local", signal: controller.signal,
      env: { GROKBOX_RUN_ROOT: dir }, stdout: { write(chunk) {
        stdout += chunk;
        releaseReady();
        if (at === "while-writing-ready") controller.abort();
      } },
    });
    try {
      expect((await within(ready)).kind).toBe("done");
      controller.abort();
      const result = await within(pending);
      expect(result.kind).toBe("done");
      if (result.kind !== "done") return;
      expect(result.value.code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ data: { process: "modeld", kind: "owned" } });
      expect(existsSync(join(dir, "modeld.sock"))).toBe(false);
      expect(process.listeners("SIGTERM").filter(listener => !initial.has(listener))).toHaveLength(0);
    } finally {
      controller.abort();
      // Clean only the legacy handler added by this owned fixture when proving
      // the old implementation red; never emit an OS/process-wide signal.
      for (const listener of process.listeners("SIGTERM")) {
        if (!initial.has(listener)) listener.call(process, "SIGTERM");
      }
      await within(pending);
      await rm(dir, { recursive: true, force: true });
    }
  }, 3500);
}

test("a failed readiness write still releases the owned modeld", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-cli-modeld-output-"));
  try {
    const result = await captureCli(["runtime", "modeld", "run", "--json"], {
      boxRuntimeRoot: dir, configDir: dir, discoveryPath: join(dir, "missing-gateway.json"),
      transport: "local", signal: new AbortController().signal, env: { GROKBOX_RUN_ROOT: dir },
      stdout: { write() { throw new Error("owned_output_unavailable"); } },
    });
    expect(result.code).not.toBe(0);
    expect(existsSync(join(dir, "modeld.sock"))).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 3000);

test("CLI completion on a borrowed modeld leaves the existing service untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-cli-modeld-borrowed-"));
  const counts = { listeners: 0, sockets: 0, fibers: 0 };
  const owner = await startModeldProcess({ durableRoot: dir, runRoot: dir, env: {}, counts });
  const controller = new AbortController();
  try {
    const result = await captureCli(["runtime", "modeld", "run", "--json"], {
      boxRuntimeRoot: dir, configDir: dir, discoveryPath: join(dir, "missing-gateway.json"),
      transport: "local", signal: controller.signal, env: { GROKBOX_RUN_ROOT: dir },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { kind: "borrowed" } });
    controller.abort();
    expect(counts.listeners).toBe(1);
    expect(existsSync(join(dir, "modeld.sock"))).toBe(true);
  } finally { await owner.stop(); await rm(dir, { recursive: true, force: true }); }
}, 3000);
