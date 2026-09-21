import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelsFile } from "@grokbox/runtime-kernel/selection";
import type { RoleClassifier } from "../src/internal/process/official-chain.ts";
import { reviewedProfilePath } from "../src/internal/io/paths.ts";
import { SOURCE, SHA, reviewed } from "./admission-fixture.ts";
import { FakeProcessTree } from "./fake-tree.ts";

/** Read-side fixture only. No old executor input, launch callback, guardian,
 * simulated apply or production fallback survives in this source fixture. */
export async function receiptFixture(mode: "identity" | "route" = "route", patched = false) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-observed-receipt-")), ephemeralRoot = join(root, "run");
  await mkdir(join(root, "profiles"));
  await writeFile(join(root, "synthetic-host.cjs"), SOURCE);
  await writeFile(reviewedProfilePath(root), JSON.stringify(reviewed));
  const tree = new FakeProcessTree(), wrapper = tree.spawn("wrapper"), supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host", patched ? undefined : { parent: supervisor });
  const touched = new Set(patched ? [host.pid] : []), gateway = { pid: host.pid }, modeld = { ready: true };
  const classify: RoleClassifier = ident => {
    const role = tree.roles().find(row => row.pid === ident.pid)?.role;
    return role === "wrapper" || role === "supervisor" || role === "host" || role === "temp-supervisor" ? role : null;
  };
  const models: ModelsFile = { version: 3, models: {}, assignments: { main: { modelId: "stub/echo" }, agents: {} } };
  const input = { root, ephemeralRoot, desired: { version: 1 as const, mode }, models,
    diskSha: SHA, reviewedProfile: structuredClone(reviewed), processes: tree, classify,
    envHas: (pid: number) => touched.has(pid), modeldReady: () => modeld.ready };
  return { root, ephemeralRoot, tree, host, supervisor, wrapper, touched, gateway, modeld, input };
}
