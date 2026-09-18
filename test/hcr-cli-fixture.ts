import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../packages/box-runtime/src/internal/host/live-slices.ts";
import { OBSERVATION_SLICE_IDS, profileFromSource } from "../packages/box-runtime/src/internal/host/profile.ts";
import { retainHostBundle } from "../packages/box-runtime/src/internal/io/provenance.node.ts";
import { LIVE_SHAPED_HOST } from "../packages/box-runtime/test/live-shaped-host.ts";

export type HcrCliRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
/** Shared assertions against the real source CLI and a cold installed Node CLI.
 * Only synthetic Host bytes and disposable roots; no Gateway, model, or adopt.
 */
export async function exerciseHcrProfileCli(run: HcrCliRunner, root: string): Promise<void> {
  const alert = LIVE_SLICE_PATCHES.find(slice => slice.id === "alert-main-decision")!;
  const source = LIVE_SHAPED_HOST.replace(alert.find, "/* unrelated upstream alert shape drift */");
  const sourceSha = sha256Text(source);
  const slices = LIVE_SLICE_PATCHES.filter(slice => !(OBSERVATION_SLICE_IDS as readonly string[]).includes(slice.id)).map(slice => ({ ...slice,
    replacement: slice.id === "ownership-read-api" ? slice.replacement.replace("localOnly: grokboxOwnershipLocalOnly === true", "localOnly: false").replace("read.capabilities(1)", "read.capabilities(0)") : slice.replacement,
  }));
  const profile = profileFromSource(source, slices, "hcr-baseline");
  await retainHostBundle({ root, source, sourceSha, profile, observedAt: "2026-01-01T00:00:00.000Z" });
  await mkdir(join(root, "profiles"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "private"), { recursive: true, mode: 0o700 });
  const profilePath = join(root, "profiles", "reviewed.json");
  const original = JSON.stringify(profile) + "\n";
  await writeFile(profilePath, original, { mode: 0o600 });
  const body = (value: string) => JSON.parse(value).data;

  const inspectFull = await run(["runtime", "profile", "analyze", "--sha", sourceSha, "--out", join(root, "private", "full.json"), "--json"]);
  expect(inspectFull.code, inspectFull.stderr).toBe(0);
  expect(body(inspectFull.stdout).envelope).toMatchObject({ refusal: "recipe_unapplicable", recipeFailure: { code: "find-missing", sliceId: "alert-main-decision" } });
  expect(body(inspectFull.stdout).next).not.toContain("profile write");
  const writeFull = await run(["runtime", "profile", "write", "--sha", sourceSha, "--json"]);
  expect(writeFull.code).toBe(2);
  expect(writeFull.stderr).toContain('"sliceId":"alert-main-decision"');
  expect(writeFull.stderr).not.toContain(alert.find.trim());
  expect(await readFile(profilePath, "utf8")).toBe(original);

  const analyzed = await run(["runtime", "profile", "analyze", "--sha", sourceSha, "--capability", "ownership-local", "--out", join(root, "private", "local.json"), "--json"]);
  expect(analyzed.code, analyzed.stderr).toBe(0);
  const analysis = body(analyzed.stdout);
  expect(analysis.envelope.refusal).toBeNull();
  expect(analysis.envelope.capabilityUpgrade.baselineProfileSha256).toBe(sha256Text(original));
  expect(analysis.next).toContain(`--expected-reviewed-sha ${sha256Text(original)}`);
  const args = ["runtime", "profile", "write", "--sha", sourceSha, "--capability", "ownership-local"];
  const missingDigest = await run([...args, "--json"]);
  expect(missingDigest.code).toBe(2);
  const written = await run([...args, "--expected-reviewed-sha", sha256Text(original), "--json"]);
  expect(written.code, written.stderr).toBe(0);
  expect(body(written.stdout)).toMatchObject({ offline: true, signaled: false, inject: false,
    capabilityUpgrade: { capability: "ownership-local", baselineProfileSha256: sha256Text(original), addedIds: [] } });
  const current = await readFile(profilePath, "utf8"), changed = JSON.parse(current);
  expect(changed.slices).toHaveLength(slices.length);
  const affected = new Set(["ownership-read-schema", "ownership-read-api", "ownership-resume-gate"]);
  for (const slice of slices) if (!affected.has(slice.id)) expect(changed.slices.find((row: { id: string }) => row.id === slice.id)).toEqual(slice);
  expect(changed.slices.find((row: { id: string }) => row.id === "ownership-read-api").replacement).toContain("localOnly: grokboxOwnershipLocalOnly === true");
  const stale = await run([...args, "--expected-reviewed-sha", sha256Text(original), "--json"]);
  expect(stale.code).toBe(2);
  expect(stale.stderr).toContain("capability_baseline_changed");
  expect(await readFile(profilePath, "utf8")).toBe(current);

  const recovery = await run(["runtime", "operation-recovery", "--json"]);
  expect(recovery.code, recovery.stderr).toBe(0);
  expect(body(recovery.stdout)).toMatchObject({ process: "operation-recovery", outcome: "clear", signaled: false, adopted: false, replayAuthorized: false });
  expect(await readFile(profilePath, "utf8")).toBe(current);

  // A tracked disposable process supplies an actually exited PID, not a guessed
  // production owner. Both source and installed Node paths exercise recovery.
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], { env: { PATH: process.env.PATH ?? "", HOME: root }, timeout: 5000 });
  expect(exited.status).toBe(0);
  await mkdir(join(root, "state"), { recursive: true });
  await mkdir(join(root, "run", "ops"), { recursive: true });
  for (const path of [join(root, "state", "controller-operations.lock"), join(root, "run", "ops", "identity.lock")]) {
    await writeFile(path, `${exited.pid}\n`, { mode: 0o600 });
  }
  const operationPath = join(root, "state", "controller-operations.json");
  const prefix = { signaled: true, spawned: true, guardian: true };
  await writeFile(operationPath, JSON.stringify({ "interrupted-fixture": { fingerprint: "f".repeat(64), state: "running", prefix } }) + "\n", { mode: 0o600 });
  const preview = await run(["runtime", "operation-recovery", "--json"]);
  expect(preview.code, preview.stderr).toBe(0);
  expect(body(preview.stdout)).toMatchObject({ outcome: "ready", markedUnknown: 0, clearedLocks: 0 });
  const recovered = await run(["runtime", "operation-recovery", "--confirm", "--json"]);
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(body(recovered.stdout)).toMatchObject({ outcome: "recovered", markedUnknown: 1, clearedLocks: 2,
    operations: { running: 0, unknown: 1 }, signaled: false, adopted: false, replayAuthorized: false });
  expect(JSON.parse(await readFile(operationPath, "utf8"))["interrupted-fixture"]).toMatchObject({ state: "unknown", prefix });
  expect(await readFile(profilePath, "utf8")).toBe(current);
}
