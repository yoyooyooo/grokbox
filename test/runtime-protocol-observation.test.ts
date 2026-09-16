import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectModeldAvailability } from "@grokbox/runtime-kernel/status";
import { WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { modeldRootId, probeModeldReplacement } from "../packages/box-runtime/src/internal/wire/modeld-probe.node.ts";
import { encodeModeldFrame, decodeModeldFrame } from "../packages/box-runtime/src/internal/wire/modeld-wire.ts";
import { captureCli, parseJson } from "./helpers.ts";

const execution = { version: 1, accepting: true, lifetimeStepLimit: null, activeSteps: 0, hotStepRecords: 0, hotTurns: 0, pinnedTurns: 0, pendingScopeReleases: 0,
  history: { kind: "leveldb", available: true, reads: 0, writes: 0, failures: 0, lastError: null },
  counters: { accepted: 0, duplicate: 0, completed: 0, reclaimedSteps: 0, coldRestores: 0, coldStores: 0, cleanupFailures: 0 } };

for (const scenario of ["legacy", "legacy-uninstrumented", "current", "current-uninstrumented", "generation-change", "foreign"] as const) {
  test(`aggregate and standalone status preserve ${scenario} observations without executing or replacing anything`, async () => {
    const root = await mkdtemp(join(tmpdir(), "protocol-observation-")), durable = join(root, "durable"), epoch = randomUUID(), nextEpoch = randomUUID();
    const legacy = scenario.startsWith("legacy"), version = legacy ? 4 : WIRE_VERSION, noExecution = scenario.endsWith("uninstrumented");
    const methods: string[] = [];
    const server = createServer(socket => {
      let pending: Buffer = Buffer.alloc(0);
      socket.on("data", chunk => {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        const decoded = decodeModeldFrame(pending); if (!decoded || "error" in decoded) return;
        pending = decoded.rest; const request = decoded.value as Record<string, unknown>, method = String(request.method);
        methods.push(method);
        if (request.version !== version) { socket.end(encodeModeldFrame({ version, ok: false, error: { code: "unsupported_version" } })); return; }
        if (method === "service-info") socket.end(encodeModeldFrame({ version, ok: true, method, serverGeneration: epoch,
          rootId: modeldRootId(scenario === "foreign" ? join(root, "other") : durable, root) }));
        else if (method === "execution-status" && !noExecution) socket.end(encodeModeldFrame({ version, ok: true, method,
          serverGeneration: scenario === "generation-change" ? nextEpoch : epoch, execution }));
        else socket.end(encodeModeldFrame({ version, ok: false, error: { code: "unknown_method" } }));
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(root, "modeld.sock"), resolve); });
    try {
      const before = await readdir(root);
      const overrides = { configDir: join(root, "no-config"), boxRuntimeRoot: durable, env: { GROKBOX_RUN_ROOT: root },
        discoveryPath: join(root, "NO_GATEWAY"), daemonSocket: join(root, "NO_DAEMON"), transport: "local" as const };
      const standalone = await captureCli(["runtime", "modeld", "status"], overrides);
      const aggregate = await captureCli(["runtime", "status"], overrides);
      expect(standalone.code, standalone.stderr).toBe(0); expect(aggregate.code, aggregate.stderr).toBe(0);
      const direct = (parseJson(standalone.stdout) as { data: Record<string, unknown> }).data;
      const facet = (parseJson(aggregate.stdout) as { data: { facets: { modeld: { value: Record<string, unknown> } } } }).data.facets.modeld.value;
      const expected = { wireVersion: version, expectedWireVersion: WIRE_VERSION, protocolCompatible: !legacy,
        protocolComparison: "observer_to_modeld", hostProtocolCompatibility: "not_observed", liveness: "reachable",
        admission: legacy ? "protocol_mismatch" : scenario === "foreign" ? "scope_mismatch" : scenario === "generation-change" ? "generation_changed"
          : noExecution ? "not_observed" : "ready" };
      expect(direct).toMatchObject(expected); expect(facet).toMatchObject(expected);
      if (noExecution) {
        expect(direct.executionGap).toBe("not_instrumented"); expect(facet.execution).toBeUndefined();
        // Diagnosable protocol identity must not weaken operator replacement.
        expect(await probeModeldReplacement(root, 100)).toBeNull();
      }
      if (scenario === "generation-change") { expect(direct.ready).toBe(false); expect(facet.ready).toBe(false); expect(facet.execution).toBeUndefined(); }
      expect(methods.every(method => method === "service-info" || method === "execution-status")).toBe(true);
      expect(await readdir(root)).toEqual(before);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  }, 10000);
}

test("availability does not trust a claimed comparison or copy unknown fields or getters", () => {
  let accesses = 0;
  const value = projectModeldAvailability({ ready: true, scope: "matched", serviceEpoch: randomUUID(), wireVersion: 4, expectedWireVersion: WIRE_VERSION,
    protocolCompatible: true, execution, secret: "PRIVATE_SENTINEL", get argv() { accesses++; throw Error("PRIVATE_SENTINEL"); } });
  expect(value).toMatchObject({ protocolCompatible: false, admission: "protocol_mismatch", hostProtocolCompatibility: "not_observed" });
  expect(accesses).toBe(0); expect(JSON.stringify(value)).not.toContain("PRIVATE_SENTINEL");
  expect(projectModeldAvailability({ ready: true, scope: "matched", serviceEpoch: randomUUID(), execution }))
    .toMatchObject({ liveness: "reachable", admission: "not_observed" });
  expect(projectModeldAvailability({ ready: true, wireVersion: "PRIVATE_SENTINEL", expectedWireVersion: Infinity, execution }))
    .toMatchObject({ liveness: "unknown", admission: "not_observed" });
});
