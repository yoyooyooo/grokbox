import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { HOST_BUNDLE_KEEP } from "../src/internal/io/provenance.node.ts";
import { hostBundlesDir } from "../src/internal/io/paths.ts";
import { observeHostProvenance } from "../src/internal/ops/host-seam/observe.ts";
import { SYNTHETIC_HOST } from "./synthetic-host.ts";

describe("HSO-1 observe/retain scaffold (honest partial)", () => {
  test("retains source bytes and knife rows without signaling", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso-observe-"));
    const from = join(root, "host.cjs");
    await writeFile(from, SYNTHETIC_HOST);
    const first = await observeHostProvenance({ root, from });
    expect(first.observedSha).toBe(sha256Text(SYNTHETIC_HOST));
    expect(first.retained).toBe("new");
    expect(first.signaled).toBe(false);
    expect(first.adopted).toBe(false);
    expect(first.keep).toBe(HOST_BUNDLE_KEEP);
    expect(first.knifePoints).toHaveLength(2);
    expect(first.installationConsistency).toBe("unknown");
    const stored = await readFile(join(hostBundlesDir(root), "generations", first.observedSha, "source"), "utf8");
    expect(stored).toBe(SYNTHETIC_HOST);
    const second = await observeHostProvenance({ root, from });
    expect(second.retained).toBe("existing");
    expect(second.signaled).toBe(false);
  });

  test("rejects symlink inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso-link-"));
    const real = join(root, "host.cjs");
    const link = join(root, "host-link.cjs");
    await writeFile(real, SYNTHETIC_HOST);
    await symlink(real, link);
    await expect(observeHostProvenance({ root, from: link })).rejects.toThrow(/regular non-symlink/);
  });
});
