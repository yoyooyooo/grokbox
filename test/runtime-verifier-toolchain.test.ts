import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const lane of ["all", "ownership-admission", "service-lifecycle"]) {
  test(`runtime ${lane} cannot qualify a different Bun or run its child tests`, () => {
    const dir = mkdtempSync(join(tmpdir(), "gbox-runtime-toolchain-"));
    try {
      const marker = join(dir, "child-was-run");
      const fakeBun = join(dir, "bun");
      writeFileSync(fakeBun, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "0.0.0\\n"; exit 0; fi\nprintf "unexpected" > "$OWNED_VERIFIER_MARKER"\nexit 97\n');
      chmodSync(fakeBun, 0o700);
      const env = { PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`, HOME: dir, OWNED_VERIFIER_MARKER: marker };
      const ran = spawnSync(process.execPath, [join(root, "scripts/verify-runtime-rebuild.mjs"), lane], {
        cwd: root, env, encoding: "utf8", timeout: 10_000,
      });
      expect(ran.error).toBeUndefined();
      expect(ran.status).toBe(1);
      const result = JSON.parse(ran.stdout);
      expect(result).toMatchObject({ ok: false, error: "toolchain_mismatch", dependencyReality: "toolchain-check-only",
        toolchain: { packageManager: "bun@1.3.14", actualBun: "0.0.0", expectedBun: "1.3.14" }, supports: [], commands: [] });
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
