import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCli } from "./helpers.ts";
import { exerciseHcrProfileCli } from "./hcr-cli-fixture.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
linuxTest("HCR source CLI preserves diagnosis, approved baseline and no-live recovery boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-hcr-cli-"));
  try {
    await exerciseHcrProfileCli(args => captureCli(args, {
      boxRuntimeRoot: root, configDir: join(root, "config"), discoveryPath: "/dev/null",
      env: { GROKBOX_RUN_ROOT: join(root, "run") },
      fetch: Object.assign(async () => { throw new Error("fixture forbids network"); },
        { preconnect: () => { throw new Error("fixture forbids network"); } }),
    }), root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("operation recovery preview is read-only and remains box-local", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-hcr-cli-observe-"));
  try {
    await mkdir(join(root, "runtime"));
    const deps = { boxRuntimeRoot: join(root, "runtime"), configDir: join(root, "config"), discoveryPath: "/dev/null",
      env: { GROKBOX_RUN_ROOT: join(root, "run") } };
    const preview = await captureCli(["runtime", "operation-recovery", "--json"], deps);
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).data).toMatchObject({ outcome: "clear", signaled: false, adopted: false, replayAuthorized: false });
    expect(await readdir(deps.boxRuntimeRoot)).toEqual([]);
    const restoration = await captureCli(["runtime", "operation-recovery", "--restore-operation", "original", "--json"], deps);
    expect(restoration.code, restoration.stderr).toBe(0);
    expect(JSON.parse(restoration.stdout).data).toMatchObject({ outcome: "blocked", reason: "restoration-confirm-required", adopted: false, replayAuthorized: false });
    expect(await readdir(deps.boxRuntimeRoot)).toEqual([]);
    const remote = await captureCli(["runtime", "operation-recovery", "--profile", "remote", "--confirm", "--json"], deps);
    expect(remote.code).toBe(2);
    expect(await readdir(deps.boxRuntimeRoot)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
