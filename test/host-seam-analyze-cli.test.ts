import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCli, parseJson } from "./helpers.ts";

function data(stdout: string): Record<string, unknown> {
  return (parseJson(stdout) as { data: Record<string, unknown> }).data;
}

describe("HSO-3 analyze CLI", () => {
  test("missing runner settles with zero effects and refuses leak paths", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso3-cli-analyze-"));
    const outDir = join(boxRuntimeRoot, "private");
    await mkdir(outDir);
    const sha = "a".repeat(64);
    const out = join(outDir, "analysis.json");
    const result = await captureCli(
      ["runtime", "profile", "analyze", "--sha", sha, "--out", out],
      { discoveryPath: "/dev/null", boxRuntimeRoot },
    );
    expect(result.code, result.stderr).toBe(0);
    const body = data(result.stdout);
    expect(body.settled).toBe("missing_runner");
    expect(body.approved).toBe(false);
    expect(body.adopt).toBe(false);
    expect(body.published).toBe(false);
    expect(body.effects).toEqual({ uploads: 0, executes: 0, writes: 0, publish: 0, upgradeRpc: 0 });
    const saved = JSON.parse(await readFile(out, "utf8"));
    expect(saved.settled).toBe("missing_runner");
    const leak = await captureCli(
      ["runtime", "profile", "analyze", "--sha", sha, "--out", join(boxRuntimeRoot, "reviewed.json")],
      { discoveryPath: "/dev/null", boxRuntimeRoot },
    );
    expect(leak.code).toBe(2);
  });
});
