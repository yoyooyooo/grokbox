import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let built = false;
/** Build once per test process; never assume a developer's existing dist is current. */
export function ensurePackedCli(): string {
  if (!built) {
    const result = spawnSync("bun", ["run", "build"], {
      cwd: root, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, GROKBOX_ALLOW_LIVE_HOST: "", GROKBOX_PACKED_SESSION_FACTORY: "", GROKBOX_PACKED_PRELOAD: "" },
    });
    if (result.error || result.status !== 0) throw new Error("Owned packed CLI build failed");
    built = true;
  }
  return fileURLToPath(new URL("../dist/index.js", import.meta.url));
}
