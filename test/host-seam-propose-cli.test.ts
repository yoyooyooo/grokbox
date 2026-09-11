import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_SHAPED_HOST } from "../packages/box-runtime/test/live-shaped-host.ts";
import { snapshotTree } from "../packages/box-runtime/test/observation-fixture.ts";
import { captureCli, parseJson } from "./helpers.ts";

function data(stdout: string): Record<string, unknown> {
  return (parseJson(stdout) as { data: Record<string, unknown> }).data;
}

describe("HSO-3 propose CLI", () => {
  test("writes candidate artifact, stdout has no source snippets, and does not touch reviewed/circuit", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso3-cli-propose-"));
    const from = join(boxRuntimeRoot, "host.cjs");
    const outDir = join(boxRuntimeRoot, "private");
    const out = join(outDir, "candidates.json");
    await writeFile(from, LIVE_SHAPED_HOST);
    await mkdir(outDir);
    await mkdir(join(boxRuntimeRoot, "state"), { recursive: true });
    const circuit = { version: 1, circuit: "open", mutationCount: 1, attemptedKeys: ["x"] };
    await writeFile(join(boxRuntimeRoot, "state", "coordinator.json"), `${JSON.stringify(circuit)}\n`);
    await writeFile(join(boxRuntimeRoot, "models.json"), `${JSON.stringify({ version: 1, models: {}, assignments: { main: null, agents: {} } })}\n`);
    const before = await snapshotTree(join(boxRuntimeRoot, "state"));
    const modelsBefore = await readFile(join(boxRuntimeRoot, "models.json"), "utf8");
    const result = await captureCli(
      ["runtime", "profile", "propose", "--from", from, "--out", out],
      { discoveryPath: "/dev/null", boxRuntimeRoot },
    );
    expect(result.code, result.stderr).toBe(0);
    const body = data(result.stdout);
    expect(body.published).toBe(false);
    expect(body.approved).toBe(false);
    expect(JSON.stringify(body)).not.toContain("createCursorInferencePromptSession");
    expect(JSON.stringify(body)).not.toContain("official-session");
    const artifact = JSON.parse(await readFile(out, "utf8"));
    expect(artifact.kind).toBe("host-seam-candidates");
    expect(artifact.published).toBe(false);
    expect(await snapshotTree(join(boxRuntimeRoot, "state"))).toEqual(before);
    expect(await readFile(join(boxRuntimeRoot, "models.json"), "utf8")).toBe(modelsBefore);
    expect(await readFile(join(boxRuntimeRoot, "profiles", "reviewed.json"), "utf8").catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
    const conflict = await captureCli(
      ["runtime", "profile", "propose", "--from", from, "--out", out],
      { discoveryPath: "/dev/null", boxRuntimeRoot },
    );
    expect(conflict.code).toBe(2);
  });
});
