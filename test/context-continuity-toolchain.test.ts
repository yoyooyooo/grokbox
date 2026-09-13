import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const verifier = join(root, "scripts/verify-context-continuity.mjs");
const packageManager = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager;

for (const lane of ["contract-e2e", "artifact-e2e"]) {
  test(`continuity ${lane} refuses a mismatched Bun before tests or packing`, () => {
    const dir = mkdtempSync(join(tmpdir(), "grokbox-toolchain-"));
    try {
      const called = join(dir, "unexpected-child");
      const fake = join(dir, "bun");
      // This owned fixture may report a version, but must never be asked to run tests/builds.
      writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '0.0.0\\n'; exit 0; fi\nprintf 'unexpected' > "$CONTINUITY_TEST_SENTINEL"\nexit 97\n`);
      chmodSync(fake, 0o700);
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`, CONTINUITY_TEST_SENTINEL: called };
      delete env.NODE_OPTIONS;
      delete env.GROKBOX_ALLOW_LIVE_HOST;
      delete env.GROKBOX_PATCH_PROFILE;
      delete env.GROKBOX_OPERATION_ID;
      delete env.GROKBOX_PACKED_SESSION_FACTORY;
      delete env.GROKBOX_PACKED_PRELOAD;
      const ran = spawnSync(process.execPath, [verifier, "--lane", lane, "--json"], {
        cwd: root, encoding: "utf8", env, timeout: 10_000,
      });
      expect(ran.error).toBeUndefined();
      expect(ran.status).toBe(1);
      const report = JSON.parse(ran.stdout);
      expect(report.ok).toBe(false);
      expect(report.error).toBe("toolchain_mismatch");
      expect(report.toolchain).toEqual({ packageManager, expectedBun: packageManager.slice(4), actualBun: "0.0.0" });
      expect(report.dependencyReality).toBe("toolchain-check-only");
      expect([true, false, null]).toContain(report.worktreeDirty);
      expect(report.supports).toEqual([]);
      expect(report.cases.every((row: { status: string }) => row.status === "unavailable")).toBe(true);
      expect(existsSync(called)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
