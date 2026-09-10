import { describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { HOST_BUNDLE_KEEP, retainHostBundle } from "../src/internal/io/provenance.node.ts";
import { hostBundlesDir } from "../src/internal/io/paths.ts";
import { observeHostProvenance } from "../src/internal/ops/host-seam/observe.ts";
import { applyRetentionPlan, buildRetentionPlan, unavailableTrash } from "../src/internal/ops/host-seam/prune.ts";
import { SYNTHETIC_HOST } from "./synthetic-host.ts";

async function hostFile(root: string, name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, body);
  return path;
}

describe("HSO-1 observe retain corpus", () => {
  test("observe.ts does not reconnect heal, signals, or upgrade RPC", async () => {
    const source = await readFile(new URL("../src/internal/ops/host-seam/observe.ts", import.meta.url), "utf8");
    expect(source).not.toContain("observeAndHeal");
    expect(source).not.toContain("signalIfMatch");
    expect(source).not.toContain("updateHostNow");
    expect(source).not.toContain("autoUpdateBoxNow");
    expect(source).not.toContain("pruneHostBundles");
  });

  test("symlink and hardlink aliases are rejected and bytes stay intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso1-alias-"));
    const real = await hostFile(root, "host.cjs", SYNTHETIC_HOST);
    const sym = join(root, "host-link.cjs");
    await symlink(real, sym);
    await expect(observeHostProvenance({ root, from: sym })).rejects.toThrow(/non-symlink/);
    const hard = join(root, "host-hard.cjs");
    await link(real, hard);
    await expect(observeHostProvenance({ root, from: hard })).rejects.toThrow(/hardlink/);
    expect(await readFile(real, "utf8")).toBe(SYNTHETIC_HOST);
  });

  test("concurrent same SHA is idempotent; different SHA keeps both generations", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso1-race-"));
    const a = await hostFile(root, "a.cjs", SYNTHETIC_HOST);
    const bBody = `${SYNTHETIC_HOST}\n// B\n`;
    const b = await hostFile(root, "b.cjs", bBody);
    const [first, again] = await Promise.all([
      observeHostProvenance({ root, from: a, now: () => "2026-01-01T00:00:00.000Z" }),
      observeHostProvenance({ root, from: a, now: () => "2026-01-01T00:00:01.000Z" }),
    ]);
    expect(new Set([first.retained, again.retained])).toEqual(new Set(["new", "existing"]));
    expect(first.observedSha).toBe(again.observedSha);
    const other = await observeHostProvenance({ root, from: b, now: () => "2026-01-01T00:00:02.000Z" });
    expect(other.observedSha).toBe(sha256Text(bBody));
    const gens = await readdir(join(hostBundlesDir(root), "generations"));
    expect(gens.sort()).toEqual([first.observedSha, other.observedSha].sort());
    expect(await readFile(a, "utf8")).toBe(SYNTHETIC_HOST);
    expect(await readFile(b, "utf8")).toBe(bBody);
  });

  test("half-written generation is corpus_corrupt and does not clobber input or stored junk", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso1-half-"));
    const from = await hostFile(root, "host.cjs", SYNTHETIC_HOST);
    const sha = sha256Text(SYNTHETIC_HOST);
    const gen = join(hostBundlesDir(root), "generations", sha);
    await mkdir(gen, { recursive: true, mode: 0o700 });
    await writeFile(join(gen, "source"), "half-written-not-matching");
    await expect(observeHostProvenance({ root, from })).rejects.toThrow(/corpus_corrupt/);
    expect(await readFile(from, "utf8")).toBe(SYNTHETIC_HOST);
    expect(await readFile(join(gen, "source"), "utf8")).toBe("half-written-not-matching");
  });

  test("KEEP=16 protects live SHA; all-protected overflow reports pressure; prune needs confirm and fresh plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso1-keep-"));
    let last = "";
    for (let i = 0; i <= HOST_BUNDLE_KEEP; i += 1) {
      const body = `${SYNTHETIC_HOST}\n// gen-${i}\n`;
      const from = await hostFile(root, `host-${i}.cjs`, body);
      const at = new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString();
      const receipt = await observeHostProvenance({ root, from, now: () => at });
      last = receipt.observedSha;
      expect(receipt.protectedShas).toContain(receipt.observedSha);
    }
    const plan = await buildRetentionPlan(root, last);
    expect(plan.remove.length).toBeGreaterThan(0);
    expect(plan.protectedShas).toContain(last);
    expect(plan.remove).not.toContain(last);
    await expect(applyRetentionPlan({ root, plan, confirm: false, liveSha: last })).rejects.toThrow(/--confirm/);
    const namesBefore = await readdir(join(hostBundlesDir(root), "generations"));
    const result = await applyRetentionPlan({
      root,
      plan,
      confirm: true,
      liveSha: last,
      trash: unavailableTrash,
    });
    expect(result.moved).toEqual([]);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(await readdir(join(hostBundlesDir(root), "generations"))).toEqual(namesBefore);

    const stale = { ...plan, remove: [...plan.remove, last], planDigest: plan.planDigest };
    await expect(applyRetentionPlan({ root, plan: stale, confirm: true, liveSha: last })).rejects.toThrow(/plan_stale/);

    const pressureRoot = await mkdtemp(join(tmpdir(), "grokbox-hso1-pressure-"));
    const shas: string[] = [];
    for (let i = 0; i <= HOST_BUNDLE_KEEP; i += 1) {
      const source = `${SYNTHETIC_HOST}\n// p-${i}\n`;
      const sourceSha = sha256Text(source);
      shas.push(sourceSha);
      await retainHostBundle({
        root: pressureRoot,
        source,
        sourceSha,
        observedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString(),
        matchedProfileId: "reviewed",
      });
    }
    const pressure = await buildRetentionPlan(pressureRoot, shas.at(-1)!, shas);
    expect(pressure.remove).toEqual([]);
    expect(pressure.retentionPressure).toBe(true);
  });
});
