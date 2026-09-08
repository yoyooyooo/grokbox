import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";
import { encodeModeldFrame } from "../src/internal/wire/modeld-wire.ts";

async function reply(runRoot: string, payload: unknown): Promise<boolean> {
  const server = createServer((socket) => {
    socket.on("data", () => socket.end(encodeModeldFrame(payload)));
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(join(runRoot, "modeld.sock"), () => resolve());
    server.on("error", reject);
  });
  try {
    return await probeModeldHealth(runRoot, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("modeld health probe", () => {
  test("old v2, empty generation, and malformed health are not ready", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "grokbox-probe-"));
    expect(await reply(runRoot, { ok: true, method: "health", version: 2, serverGeneration: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })).toBe(false);
  });

  test("v3 with empty generation is not ready; v3 uuid is ready", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "grokbox-probe-empty-"));
    expect(await reply(emptyRoot, { ok: true, method: "health", version: 3, serverGeneration: "" })).toBe(false);
    const v3Root = await mkdtemp(join(tmpdir(), "grokbox-probe-v3-"));
    expect(await reply(v3Root, {
      ok: true,
      method: "health",
      version: 3,
      serverGeneration: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    })).toBe(true);
  });
});
