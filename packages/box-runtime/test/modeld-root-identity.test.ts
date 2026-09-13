import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { requestModeld } from "../src/internal/host/modeld-client.node.ts";
import { modeldRootId } from "../src/internal/wire/modeld-probe.node.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";

// All roots, listeners and credentials are owned by this fixture. Borrowing
// another root's listener is a wrong-service success, not a connection failure.
test("a healthy socket for another durable root is not a borrowable modeld", async () => {
  const root = await mkdtemp(join(tmpdir(), "gbox-root-identity-"));
  const runRoot = join(root, "run");
  const owner = await startModeldProcess({ durableRoot: join(root, "first"), runRoot, env: {} });
  let unexpected: Awaited<ReturnType<typeof startModeldProcess>> | undefined;
  try {
    let error: unknown;
    try { unexpected = await startModeldProcess({ durableRoot: join(root, "second"), runRoot, env: {} }); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ message: "modeld_root_mismatch" });
    expect(await probeModeldHealth(runRoot, 500)).toBe(true);
    const health = await requestModeld(runRoot, { method: "health", version: 4 });
    expect(Object.keys(health[0] as object).sort()).toEqual(["method", "ok", "serverGeneration", "version"]);
    const info = await requestModeld(runRoot, { method: "service-info", version: 4 });
    expect(info).toEqual([{ ok: true, method: "service-info", version: 4,
      serverGeneration: owner.ensure.kind === "owned" ? owner.ensure.generation : "unexpected",
      rootId: modeldRootId(join(root, "first"), runRoot) }]);
    expect(JSON.stringify(info)).not.toContain(root);
    const matching = await startModeldProcess({ durableRoot: join(root, "first"), runRoot, env: {} });
    expect(matching.ensure.kind).toBe("borrowed");
    await matching.stop();
    expect(await probeModeldHealth(runRoot, 500)).toBe(true);
  } finally {
    await unexpected?.stop();
    await owner.stop();
    await rm(root, { recursive: true, force: true });
  }
});
