import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  HOST_BUNDLE_KEEP,
  buildHostBundleDiff,
  observeHostBundles,
  pruneHostBundles,
  retainHostBundle,
} from "../src/internal/io/provenance.node.ts";
import { hostBundlesDir } from "../src/internal/io/paths.ts";
import { observeAndHeal } from "../src/internal/process/watchdog.ts";
import { SYNTHETIC_HOST } from "./synthetic-host.ts";
import { FakeProcessTree } from "./fake-tree.ts";

const AT = "2026-01-01T00:00:00.000Z";

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "grokbox-host-bundles-"));
}

describe("host full-bundle provenance", () => {
  test("retain is content-addressed, append-only, and idempotent for the same SHA", async () => {
    const dir = await root();
    const sourceSha = sha256Text(SYNTHETIC_HOST);
    const first = await retainHostBundle({ root: dir, source: SYNTHETIC_HOST, sourceSha, observedAt: AT, matchedProfileId: "reviewed" });
    expect(first.retained).toBe("new");
    expect(first.meta).toMatchObject({ sourceSha, matchedProfileId: "reviewed" });
    expect(first.diff).toBeNull();
    const stored = await readFile(join(hostBundlesDir(dir), "generations", sourceSha, "source"), "utf8");
    expect(stored).toBe(SYNTHETIC_HOST);
    expect(sha256Text(stored)).toBe(sourceSha);
    const sourceStat = await lstat(join(hostBundlesDir(dir), "generations", sourceSha, "source"));
    const later = "2026-01-02T00:00:00.000Z";
    const second = await retainHostBundle({
      root: dir, source: SYNTHETIC_HOST, sourceSha, observedAt: later, matchedProfileId: "other",
    });
    expect(second.retained).toBe("existing");
    expect(second.meta.observedAt).toBe(AT);
    expect(second.meta.matchedProfileId).toBe("reviewed");
    const after = await lstat(join(hostBundlesDir(dir), "generations", sourceSha, "source"));
    expect(after.size).toBe(sourceStat.size);
    expect(await readFile(join(hostBundlesDir(dir), "generations", sourceSha, "source"), "utf8")).toBe(SYNTHETIC_HOST);
  });

  test("rejects a SHA that does not match bytes and never overwrites a stored SHA", async () => {
    const dir = await root();
    const sourceSha = sha256Text(SYNTHETIC_HOST);
    await retainHostBundle({ root: dir, source: SYNTHETIC_HOST, sourceSha, observedAt: AT });
    await expect(retainHostBundle({
      root: dir, source: SYNTHETIC_HOST, sourceSha: "a".repeat(64), observedAt: AT,
    })).rejects.toThrow(/host-bundle-sha-mismatch/);
    const gen = join(hostBundlesDir(dir), "generations", sourceSha);
    const original = await readFile(join(gen, "source"), "utf8");
    await writeFile(join(gen, "source"), "corrupted-not-the-stored-host");
    await expect(retainHostBundle({
      root: dir, source: SYNTHETIC_HOST, sourceSha, observedAt: AT,
    })).rejects.toThrow(/host-bundle-bytes-mismatch/);
    expect(await readFile(join(gen, "source"), "utf8")).toBe("corrupted-not-the-stored-host");
    expect(original).toBe(SYNTHETIC_HOST);
  });

  test("diff and patch-impact map drifted knife-points for re-review", async () => {
    const dir = await root();
    const firstSha = sha256Text(SYNTHETIC_HOST);
    await retainHostBundle({ root: dir, source: SYNTHETIC_HOST, sourceSha: firstSha, observedAt: AT });
    const next = SYNTHETIC_HOST.replace("official-main", "official-next");
    const nextSha = sha256Text(next);
    const retained = await retainHostBundle({
      root: dir, source: next, sourceSha: nextSha, observedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(retained.retained).toBe("new");
    expect(retained.diff?.previousSha).toBe(firstSha);
    expect(retained.diff?.hunks).toBe(1);
    expect(retained.diff?.addedLines).toBeGreaterThan(0);
    expect(retained.diff?.driftedSlices.length).toBeGreaterThan(0);
    expect(retained.diff?.patchImpact.some((row) => row.slice === "session-options" && row.review === "re-review")).toBe(true);
    const rebuilt = buildHostBundleDiff(firstSha, SYNTHETIC_HOST, next);
    expect(rebuilt.driftedSlices).toEqual(retained.diff?.driftedSlices ?? []);
    const observed = await observeHostBundles(dir);
    expect(JSON.stringify(observed)).not.toContain("function createSession");
    expect(JSON.stringify(observed)).not.toContain("official-next");
    expect(observed.head).toBe(nextSha);
    expect(observed.generations).toHaveLength(2);
    expect(observed.generations[0]?.diff?.previousSha).toBe(firstSha);
  });

  test("prune keeps live and last profile-matched SHA and drops older extras", async () => {
    const dir = await root();
    const shas: string[] = [];
    for (let i = 0; i < HOST_BUNDLE_KEEP + 3; i += 1) {
      const source = `${SYNTHETIC_HOST}\n// gen-${i}\n`;
      const sourceSha = sha256Text(source);
      shas.push(sourceSha);
      await retainHostBundle({
        root: dir,
        source,
        sourceSha,
        observedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        ...(i === 1 ? { matchedProfileId: "reviewed" } : {}),
      });
    }
    const liveSha = shas.at(-1)!;
    const matchedSha = shas[1]!;
    await pruneHostBundles({ root: dir, liveSha, lastMatchedSha: matchedSha });
    const names = await readdir(join(hostBundlesDir(dir), "generations"));
    expect(names).toContain(liveSha);
    expect(names).toContain(matchedSha);
    expect(names).toHaveLength(HOST_BUNDLE_KEEP);
    expect(names).not.toContain(shas[0]);
  });

  test("watchdog observe retains the full bundle without touching transform output", async () => {
    const dir = await root();
    const tree = new FakeProcessTree();
    const host = tree.spawn("host");
    const sha = sha256Text(SYNTHETIC_HOST);
    await observeAndHeal({
      root: dir,
      disk: { source: SYNTHETIC_HOST },
      processes: tree,
      host,
      attestation: null,
      now: () => AT,
      matchedProfileId: "reviewed",
    });
    const stored = await readFile(join(hostBundlesDir(dir), "generations", sha, "source"), "utf8");
    expect(stored).toBe(SYNTHETIC_HOST);
    const again = await observeAndHeal({
      root: dir,
      disk: { source: SYNTHETIC_HOST },
      processes: tree,
      host,
      attestation: null,
      now: () => "2026-01-01T00:00:01.000Z",
      matchedProfileId: "reviewed",
    });
    expect(again.result.injected).toBe(false);
    expect(await readFile(join(hostBundlesDir(dir), "generations", sha, "source"), "utf8")).toBe(SYNTHETIC_HOST);
    const contracts = await readdir(join(dir, "contracts", "generations"));
    expect(contracts).toContain(sha);
  });
});
