import { expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("bundled Node provider single-call pipeline keeps valid/invalid boundaries", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "owned-node-provider-"));
  try {
    const outfile = join(dir, "probe.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/box-runtime/test/fixtures/provider-stream-node.ts"], outfile,
      bundle: true, platform: "node", target: "node20", format: "esm", logLevel: "silent",
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const result = spawnSync("node", [outfile], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("MaxListenersExceededWarning");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.runtime).toMatch(/^v\d+\./);
    expect(parsed.results).toEqual([
      { name: "valid", outcome: "Success", httpCalls: 1, finishCount: 1, cause: null },
      { name: "trailing_args", outcome: "Failure", httpCalls: 1, finishCount: 0, cause: "tool_arguments_invalid" },
      { name: "undeclared", outcome: "Failure", httpCalls: 1, finishCount: 0, cause: "undeclared_tool" },
      { name: "missing_finish", outcome: "Failure", httpCalls: 1, finishCount: 0, cause: "missing_finish" },
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);
