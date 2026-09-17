import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDaemonConfig } from "../packages/cli/src/daemon/config.ts";
import { DesktopManager, type DesktopIo } from "../packages/cli/src/daemon/desktop.ts";
import { openConfigStore, rootConfigLayout, observeConfigApplication } from "@grokbox/box-runtime/runtime";
import { captureCli, parseJson } from "./helpers.ts";

function emptyIo(): DesktopIo {
  return {
    readWorld: async (nowMs) => ({ nowMs, assignments: {}, names: {}, litDisplays: new Set(), displayStartedAtMs: {},
      transcriptWrittenAtMs: {}, busyMarkers: new Set(), grokDisplays: new Set(), taskDisplays: new Set(), startWindowDisplays: new Set() }),
    stopWindow: async () => { throw new Error("no display may be stopped by these tests"); },
    reapLogs: async () => undefined, unseatAgent: async () => undefined,
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-application-"));
  await writeDaemonConfig(root, { version: 1, desktop: { pruneEnabled: false } });
  return { root, deps: { configDir: root, boxRuntimeRoot: root, env: {} } };
}
const data = (text: string): any => (parseJson(text) as any).data;

describe("configuration commit and live consumer application", () => {
  test("wait-applied waits for the actual desktop tick and queries never acknowledge", async () => {
    const { root, deps } = await fixture();
    const manager = await DesktopManager.create(root, Date.now, {}, emptyIo(), 5);
    try {
      const changed = await captureCli(["config", "set", "desktop.idleReclaim.enabled", "true", "--wait-applied", "--timeout-ms", "2000"], deps);
      expect(changed.code, changed.stderr).toBe(0);
      const receipt = data(changed.stdout);
      expect(receipt.commit).toBe("committed");
      expect(receipt.application).toMatchObject({ state: "applied", consumers: [{ consumer: "desktop", state: "applied" }] });
      expect((await manager.status()).pruneEnabled).toBe(true);
      const path = join(root, "state", "config-consumers", "desktop.json");
      const before = await readFile(path, "utf8");
      const query = await captureCli(["config", "get", "desktop", "--effective"], deps);
      expect(query.code, query.stderr).toBe(0);
      expect(await readFile(path, "utf8")).toBe(before);
      const unrelated = await captureCli(["config", "set", "ops.monitor.deepReplay", "true"], deps);
      expect(unrelated.code, unrelated.stderr).toBe(0);
      expect((await observeConfigApplication(root, receipt)).state).toBe("applied");
      await manager.close();
      expect((await observeConfigApplication(root, receipt)).state).toBe("pending");
    } finally { await manager.close(); }
  });

  test("unavailable consumer reports saved revision on timeout and never reverts intent", async () => {
    const { root, deps } = await fixture();
    const before = (await openConfigStore(rootConfigLayout(root)).read()).revision;
    const changed = await captureCli(["config", "set", "desktop.idleReclaim.enabled", "true", "--wait-applied", "--timeout-ms", "30", "--operation-id", "pending-test"], deps);
    expect(changed.code).toBe(80);
    const error = (parseJson(changed.stderr) as any).error;
    expect(error).toMatchObject({ code: "config_apply_pending", context: { operationId: "pending-test", commit: "committed", application: "pending" } });
    const now = await openConfigStore(rootConfigLayout(root)).read();
    expect(now.document.desktop?.idleReclaim?.enabled).toBe(true);
    expect(now.revision).not.toBe(before);
    expect(error.context.configRevision).toBe(now.revision);
    expect(changed.stdout).toBe("");
  });

  test("invalid wait budget refuses before writing and client changes need no consumer", async () => {
    const { root, deps } = await fixture();
    const before = await readFile(join(root, "config.json"), "utf8");
    const refused = await captureCli(["config", "set", "desktop.idleReclaim.enabled", "true", "--timeout-ms", "0"], deps);
    expect(refused.code).toBe(2);
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(before);
    const client = await captureCli(["config", "set", "client.profiles.default.transport", "--string", "local", "--wait-applied"], deps);
    expect(client.code, client.stderr).toBe(0);
    expect(data(client.stdout).application.state).toBe("not-required");
  });
});
