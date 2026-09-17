import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modeldRootId, probeModeldIdentity } from "../src/internal/wire/modeld-probe.node.ts";
import { launchPackedRuntime, processDeadline, closePackedRuntime } from "./fixtures/packed-runtime-process.ts";

// Valid configuration exercises the real parser. No model/network/attestation
// is fabricated: startup is transport preparation, not inference acceptance.
const models = { version: 1, models: {}, assignments: { main: null, agents: {} } };
type Child = ReturnType<typeof launchPackedRuntime>;

for (const mode of ["observe", "identity", "route"] as const) {
  test(`packed runtime start ${mode}: repeat borrows, orderly restart reloads config without adoption`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbox-start-packed-"));
    const root = join(dir, "durable"), run = join(dir, "run");
    const children: Child[] = [];
    await mkdir(root, { recursive: true, mode: 0o700 });
    const modelBytes = JSON.stringify(models);
    await writeFile(join(root, "models.json"), modelBytes);
    try {
      const owner = launchPackedRuntime(dir, ["start", "--mode", mode]); children.push(owner);
      const initial = await processDeadline(owner.ready);
      expect(initial).toMatchObject({ ok: true, data: {
        process: "start", desired: mode, inject: false, reAdopt: false, productionAccepted: false,
        service: { lifetime: "foreground", autostartInstalled: false },
        modeld: { kind: "owned", ready: true, path: join(run, "modeld.sock") },
      } });
      const firstIdentity = await probeModeldIdentity(run, 500);
      expect(firstIdentity?.rootId).toBe(modeldRootId(root, run));
      expect(initial.data.modeld.generation).toBe(firstIdentity?.generation);
      expect(initial.data.status.facets.modeld).toMatchObject({ gap: null,
        value: { ready: true, scope: "matched", serviceEpoch: firstIdentity?.generation } });
      expect(initial.data.reconciliation === null).toBe(mode === "observe");
      if (mode !== "observe") {
        expect(initial.data.reconciliation).toMatchObject({ signaled: false, spawned: false, guardian: false });
      }
      const again = launchPackedRuntime(dir, ["start", "--mode", mode]); children.push(again);
      const reused = await processDeadline(again.ready);
      expect(reused).toMatchObject({ data: { modeld: { kind: "borrowed" }, service: { lifetime: "borrowed" } } });
      expect(reused.data.configRevision).toBe(initial.data.configRevision);
      expect(await processDeadline(again.exit)).toEqual({ code: 0, signal: null });
      expect(owner.child.exitCode).toBeNull();
      expect(await probeModeldIdentity(run, 500)).toEqual(firstIdentity);
      expect(await closePackedRuntime(owner)).toEqual({ code: 0, signal: null });
      expect(existsSync(join(run, "modeld.sock"))).toBe(false);
      expect(JSON.parse(await readFile(join(root, "config.json"), "utf8")).runtime.desiredMode).toBe(mode);
      const restarted = launchPackedRuntime(dir, ["start", "--mode", mode]); children.push(restarted);
      const after = await processDeadline(restarted.ready);
      expect(after.data.configRevision).toBe(initial.data.configRevision);
      expect(after.data.modeld.generation).not.toBe(initial.data.modeld.generation);
      expect((await probeModeldIdentity(run, 500))?.rootId).toBe(firstIdentity?.rootId);
      expect(await readFile(join(root, "models.json"), "utf8")).toBe(modelBytes);
      expect(existsSync(join(run, "attestation.json"))).toBe(false);
      expect(existsSync(join(run, "ops/adopt.json"))).toBe(false);
      expect(existsSync(join(root, "state/controller-operations.json"))).toBe(false);
      expect(await closePackedRuntime(restarted)).toEqual({ code: 0, signal: null });
      for (const child of children) expect(child.output().stderr).toBe("");
    } finally {
      for (const child of children.reverse()) await closePackedRuntime(child);
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
}

for (const condition of ["missing", "malformed", "symlink", "unknown-model"] as const) {
  test(`packed route rejects ${condition} config without saving intent or starting a service`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbox-start-packed-invalid-"));
    const root = join(dir, "durable");
    await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
    const desired = JSON.stringify({ schemaVersion: 3, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "disabled" } });
    await writeFile(join(root, "config.json"), desired, { mode: 0o600 });
    if (condition === "malformed") await writeFile(join(root, "models.json"), "{");
    if (condition === "symlink") {
      await writeFile(join(dir, "other.json"), JSON.stringify(models));
      await symlink(join(dir, "other.json"), join(root, "models.json"));
    }
    if (condition === "unknown-model") await writeFile(join(root, "models.json"), JSON.stringify({ ...models,
      assignments: { main: null, agents: { fixture: "openai/not-defined" } } }));
    const child = launchPackedRuntime(dir, ["start", "--mode", "route"]);
    try {
      expect(await processDeadline(child.exit)).toEqual({ code: 2, signal: null });
      expect(child.output().stdout).toBe("");
      expect(JSON.parse(child.output().stderr)).toMatchObject({ error: { code: "invalid_usage" } });
      expect(await readFile(join(root, "config.json"), "utf8")).toBe(desired);
      expect(existsSync(join(dir, "run/modeld.sock"))).toBe(false);
    } finally { await closePackedRuntime(child); await rm(dir, { recursive: true, force: true }); }
  }, 8000);
}

test("packed start rejects another root without activating or stopping its healthy service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-start-packed-root-"));
  const owner = launchPackedRuntime(dir, ["modeld", "run"]);
  let borrower: Child | undefined;
  try {
    await processDeadline(owner.ready);
    const before = await probeModeldIdentity(join(dir, "run"), 500);
    borrower = launchPackedRuntime(dir, ["start", "--mode", "observe"], join(dir, "foreign"));
    expect((await processDeadline(borrower.exit)).code).not.toBe(0);
    expect(borrower.output().stdout).toBe("");
    expect(borrower.output().stderr).toContain("modeld_root_mismatch");
    expect(await probeModeldIdentity(join(dir, "run"), 500)).toEqual(before);
    expect(existsSync(join(dir, "foreign"))).toBe(false);
  } finally {
    if (borrower) await closePackedRuntime(borrower);
    await closePackedRuntime(owner); await rm(dir, { recursive: true, force: true });
  }
}, 12000);
