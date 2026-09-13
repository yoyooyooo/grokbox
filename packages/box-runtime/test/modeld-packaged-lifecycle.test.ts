import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";

const entry = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));
import { launchPackedRuntime, processDeadline as deadline, closePackedRuntime as close } from "./fixtures/packed-runtime-process.ts";
function launch(dir: string, durableRoot = join(dir, "durable")) {
  return launchPackedRuntime(dir, ["modeld", "run"], durableRoot);
}

test("published Node modeld survives CLI borrowing and closes only its owned socket on SIGTERM", async () => {
  expect(existsSync(entry)).toBe(true);
  const dir = await mkdtemp(join(tmpdir(), "gbox-node-service-"));
  let owner: ReturnType<typeof launch> | undefined;
  let borrower: ReturnType<typeof launch> | undefined;
  try {
    owner = launch(dir);
    expect(await deadline(owner.ready)).toMatchObject({ data: { process: "modeld", kind: "owned", path: join(dir, "run/modeld.sock") } });
    expect(await probeModeldHealth(join(dir, "run"), 500)).toBe(true);
    borrower = launch(dir);
    expect(await deadline(borrower.ready)).toMatchObject({ data: { kind: "borrowed" } });
    expect(await deadline(borrower.exit)).toEqual({ code: 0, signal: null });
    expect(owner.child.exitCode).toBeNull();
    expect(await probeModeldHealth(join(dir, "run"), 500)).toBe(true);
    expect(await close(owner)).toEqual({ code: 0, signal: null });
    expect(existsSync(join(dir, "run/modeld.sock"))).toBe(false);
    expect(owner.output().stderr).toBe("");
    // No activation, fake attestation or model config is fabricated to make a
    // transport-readiness test look like production inference readiness.
    expect(existsSync(join(dir, "durable/models.json"))).toBe(false);
    expect(existsSync(join(dir, "run/attestation.json"))).toBe(false);
  } finally {
    if (borrower) await close(borrower);
    if (owner) await close(owner);
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);

test("packaged Node refuses to borrow a healthy service from another durable root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-node-root-scope-"));
  const owner = launch(dir);
  let foreign: ReturnType<typeof launch> | undefined;
  try {
    await deadline(owner.ready);
    foreign = launch(dir, join(dir, "other-durable"));
    const exit = await deadline(foreign.exit);
    expect(exit.code).not.toBe(0);
    expect(exit.signal).toBeNull();
    expect(foreign.output().stdout).toBe("");
    expect(foreign.output().stderr).toContain("modeld_root_mismatch");
    expect(owner.child.exitCode).toBeNull();
    expect(await probeModeldHealth(join(dir, "run"), 500)).toBe(true);
    expect(existsSync(join(dir, "other-durable"))).toBe(false);
  } finally {
    if (foreign) await close(foreign);
    await close(owner);
    await rm(dir, { recursive: true, force: true });
  }
}, 12000);

test("packaged Node refuses an occupied non-socket path without replacing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-node-occupied-"));
  await mkdir(join(dir, "run"));
  const socket = join(dir, "run/modeld.sock");
  await writeFile(socket, "owned-foreign-file", { flag: "wx" });
  const process = launch(dir);
  try {
    const exit = await deadline(process.exit);
    expect(exit.code).not.toBe(0);
    expect(exit.signal).toBeNull();
    expect(process.output().stdout).toBe("");
    expect(await readFile(socket, "utf8")).toBe("owned-foreign-file");
  } finally { await close(process); await rm(dir, { recursive: true, force: true }); }
}, 8000);
