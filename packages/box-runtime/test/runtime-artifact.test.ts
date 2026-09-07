import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRuntimeArtifact } from "../src/runtime-artifact.ts";

describe("runtime receipt artifact publication", () => {
  test("concurrent readers see complete private JSON, not staged bytes", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "grokbox-artifact-"));
    const path = join(root, "state", "receipt.json");
    await writeRuntimeArtifact(path, { generation: 0 });
    let done = false;
    const observed: number[] = [];
    const reader = (async () => {
      while (!done) observed.push(JSON.parse(await fs.readFile(path, "utf8")).generation);
    })();
    try {
      await Promise.all([1, 2, 3].map((generation) => writeRuntimeArtifact(path, { generation })));
    } finally { done = true; await reader; }
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((value) => [0, 1, 2, 3].includes(value))).toBe(true);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(join(root, "state"))).mode & 0o777).toBe(0o700);
  });

  test("failed promotion preserves the existing attestation and unpublished staging", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "grokbox-artifact-refuse-"));
    const path = join(root, "attestation.json");
    await writeRuntimeArtifact(path, { generation: "old-fixture" });
    const rename = fs.rename;
    const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === path) throw new Error("fixture-rename-failure");
      return rename(from, to);
    });
    try {
      await expect(writeRuntimeArtifact(path, { generation: "new-fixture" })).rejects.toThrow("fixture-rename-failure");
      expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ generation: "old-fixture" });
      const staging = (await fs.readdir(root)).filter((name) => name.endsWith(".tmp"));
      expect(staging).toHaveLength(1);
      expect((await fs.stat(join(root, staging[0]!))).mode & 0o777).toBe(0o600);
    } finally { spy.mockRestore(); }
  });
});
