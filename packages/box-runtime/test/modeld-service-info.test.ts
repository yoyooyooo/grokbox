import { expect, test } from "bun:test";
import { WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { acceptModeldFrame, encodeModeldFrame, parseModeldRequest } from "../src/internal/wire/modeld-wire.ts";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { probeModeldHealth, probeModeldIdentity } from "../src/internal/wire/modeld-probe.node.ts";

const generation = randomUUID();
const valid = { ok: true, method: "service-info", version: WIRE_VERSION, serverGeneration: generation, rootId: "a".repeat(64) };

test("service-info is an explicit finite query, never an extension of ordinary health", () => {
  expect(parseModeldRequest({ version: WIRE_VERSION, method: "service-info" })).toEqual({ method: "service-info" });
  expect(() => parseModeldRequest({ version: WIRE_VERSION, method: "service-info", rootId: valid.rootId })).toThrow();
  expect(acceptModeldFrame({ method: "service-info" }, valid).done).toBe(true);
  expect(acceptModeldFrame({ method: "service-info" }, { ...valid, rootId: null }).done).toBe(true);
  expect(() => acceptModeldFrame({ method: "health" }, valid)).toThrow();
});

for (const [label, change] of [
  ["root-not-a-digest", { rootId: "PRIVATE_SENTINEL" }],
  ["root-omitted", { rootId: undefined }],
  ["wrong-version", { version: 3 }],
  ["wrong-generation", { serverGeneration: "wrong" }],
  ["extra-data", { credentials: "PRIVATE_SENTINEL" }],
] as const) {
  test(`service-info refuses ${label}`, () => {
    expect(() => acceptModeldFrame({ method: "service-info" }, { ...valid, ...change })).toThrow();
  });
}

for (const scenario of ["legacy", "missing-root", "extra-frame", "malformed-root"] as const) {
  test(`healthy ${scenario} peer cannot qualify borrowing and is never stopped`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gbox-peer-info-"));
    let connections = 0;
    const peer = createServer(socket => {
      connections++;
      socket.once("data", bytes => {
        const request = JSON.parse(Buffer.from(bytes).subarray(4).toString("utf8"));
        if (request.method === "health") {
          socket.end(encodeModeldFrame({ ok: true, method: "health", version: WIRE_VERSION, serverGeneration: generation }));
        } else if (scenario === "legacy") {
          socket.end(encodeModeldFrame({ ok: false, version: WIRE_VERSION, error: { code: "unknown_method" } }));
        } else {
          const frame = encodeModeldFrame({ ...valid, rootId: scenario === "missing-root" ? null : scenario === "malformed-root" ? "wrong" : valid.rootId });
          socket.end(scenario === "extra-frame" ? Buffer.concat([frame, frame]) : frame);
        }
      });
    });
    await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(join(root, "modeld.sock"), resolve); });
    try {
      expect(await probeModeldHealth(root, 500)).toBe(true);
      expect(await probeModeldIdentity(root, 500)).toBeNull();
      await expect(startModeldProcess({ durableRoot: root, runRoot: root, env: {} })).rejects.toMatchObject({ message: "modeld_identity_unavailable" });
      expect(peer.listening).toBe(true);
      expect(connections).toBe(4);
    } finally {
      await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
