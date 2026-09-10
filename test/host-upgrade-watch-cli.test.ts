import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { hostBundlesDir } from "../packages/box-runtime/src/internal/io/paths.ts";
import { SYNTHETIC_HOST } from "../packages/box-runtime/test/synthetic-host.ts";
import { captureCli, parseJson } from "./helpers.ts";

function data(stdout: string): Record<string, unknown> {
  return (parseJson(stdout) as { data: Record<string, unknown> }).data;
}

describe("HSO-1 watch CLI closeout", () => {
  test("watch without --once fails closed; --once owns zero tasks and does not signal", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso1-watch-"));
    const missing = await captureCli(["runtime", "profile", "watch"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(missing.code).toBe(2);
    const once = await captureCli(["runtime", "profile", "watch", "--once"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(once.code, once.stderr).toBe(0);
    expect(data(once.stdout)).toMatchObject({
      process: "profile-watch",
      once: true,
      owned: 0,
      signaled: false,
      adopted: false,
    });
  });

  test("watch --once --from then A→B→A leaves two gens, HEAD at A, owned zero", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso1-watch-aba-"));
    const hostA = join(boxRuntimeRoot, "host.cjs");
    const hostB = join(boxRuntimeRoot, "host-b.cjs");
    const bodyB = `${SYNTHETIC_HOST}\n// B\n`;
    await writeFile(hostA, SYNTHETIC_HOST);
    await writeFile(hostB, bodyB);
    const deps = { discoveryPath: "/dev/null", boxRuntimeRoot };
    const a = await captureCli(["runtime", "profile", "watch", "--once", "--from", hostA], deps);
    const b = await captureCli(["runtime", "profile", "watch", "--once", "--from", hostB], deps);
    const aAgain = await captureCli(["runtime", "profile", "watch", "--once", "--from", hostA], deps);
    expect([a.code, b.code, aAgain.code]).toEqual([0, 0, 0]);
    expect(data(aAgain.stdout).owned).toBe(0);
    const shaA = sha256Text(SYNTHETIC_HOST);
    const shaB = sha256Text(bodyB);
    const bundles = hostBundlesDir(boxRuntimeRoot);
    expect((await readFile(join(bundles, "HEAD"), "utf8")).trim()).toBe(shaA);
    expect(await readFile(join(bundles, "generations", shaA, "source"), "utf8")).toBe(SYNTHETIC_HOST);
    expect(await readFile(join(bundles, "generations", shaB, "source"), "utf8")).toBe(bodyB);
    const observeA = data(aAgain.stdout).observe as { retained?: string };
    expect(observeA.retained).toBe("existing");
  });
});
