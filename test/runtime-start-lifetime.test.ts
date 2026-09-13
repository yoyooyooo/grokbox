import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModeldProcess } from "@grokbox/box-runtime/runtime";
import { liveMutationAttempts } from "../packages/box-runtime/src/internal/roots/controller-program.node.ts";
import { captureCli } from "./helpers.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gbox-start-cli-"));
  const root = join(dir, "durable"), run = join(dir, "run");
  return { dir, root, run, deps: { configDir: join(dir, "config"), boxRuntimeRoot: root,
    discoveryPath: join(dir, "absent-gateway.json"), daemonSocket: join(dir, "absent-daemon.sock"),
    transport: "local" as const, env: { GROKBOX_RUN_ROOT: run } } };
}
const validModels = { version: 1, models: {}, assignments: { main: null, agents: {} } };

for (const mode of ["observe", "identity", "route"] as const) {
  test(`runtime start ${mode} owns its foreground service and does not adopt a Host`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    const signals = { ...liveMutationAttempts };
    let output = "";
    if (mode === "route") {
      await mkdir(f.root, { recursive: true });
      await writeFile(join(f.root, "models.json"), JSON.stringify(validModels));
    }
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const result = await captureCli(["runtime", "start", "--mode", mode, "--json"], {
        ...f.deps, signal: controller.signal,
        stdout: { write(chunk) { output += chunk; controller.abort(); } },
      });
      expect(result.code).toBe(0);
      const receipt = JSON.parse(output).data;
      expect(receipt).toMatchObject({ process: "start", desired: mode, inject: false, reAdopt: false,
        productionAccepted: false, service: { lifetime: "foreground", autostartInstalled: false },
        modeld: { kind: "owned", ready: true, path: join(f.run, "modeld.sock") } });
      expect(typeof receipt.configRevision).toBe("string");
      expect(receipt.reconciliation === null).toBe(mode === "observe");
      expect(JSON.parse(await readFile(join(f.root, "state/desired.json"), "utf8"))).toEqual({ version: 1, mode });
      expect(existsSync(join(f.run, "modeld.sock"))).toBe(false);
      expect(liveMutationAttempts).toEqual(signals);
    } finally { clearTimeout(timeout); controller.abort(); await rm(f.dir, { recursive: true, force: true }); }
  }, 4500);
}

test("runtime start borrows same-root service and leaves its owner's lifetime intact", async () => {
  const f = await fixture();
  const counts = { listeners: 0, sockets: 0, fibers: 0 };
  const owner = await startModeldProcess({ durableRoot: f.root, runRoot: f.run, env: {}, counts });
  try {
    const result = await captureCli(["runtime", "start", "--mode", "observe", "--json"], {
      ...f.deps, signal: new AbortController().signal,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { service: { lifetime: "borrowed" }, modeld: { kind: "borrowed" } } });
    expect(counts.listeners).toBe(1);
    expect(existsSync(join(f.run, "modeld.sock"))).toBe(true);
  } finally { await owner.stop(); await rm(f.dir, { recursive: true, force: true }); }
}, 3500);

test("runtime start cannot activate a different root through an already healthy socket", async () => {
  const f = await fixture();
  const owner = await startModeldProcess({ durableRoot: join(f.dir, "other"), runRoot: f.run, env: {} });
  try {
    const result = await captureCli(["runtime", "start", "--mode", "observe"], { ...f.deps, signal: new AbortController().signal });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("modeld_root_mismatch");
    expect(existsSync(join(f.root, "state/desired.json"))).toBe(false);
    expect(existsSync(join(f.run, "modeld.sock"))).toBe(true);
  } finally { await owner.stop(); await rm(f.dir, { recursive: true, force: true }); }
}, 3500);

for (const issue of ["missing", "malformed", "symlink", "oversize", "unknown-assignment"] as const) {
  test(`runtime start route rejects ${issue} configuration before service or desired write`, async () => {
    const f = await fixture();
    try {
      await mkdir(f.root, { recursive: true });
      const file = join(f.root, "models.json");
      if (issue === "malformed") await writeFile(file, "{");
      if (issue === "symlink") {
        await writeFile(join(f.dir, "other-models.json"), JSON.stringify(validModels));
        await symlink(join(f.dir, "other-models.json"), file);
      }
      if (issue === "oversize") await writeFile(file, " ".repeat(128 * 1024 + 1));
      if (issue === "unknown-assignment") await writeFile(file, JSON.stringify({ ...validModels, assignments: { main: null, agents: { fixture: "openai/not-defined" } } }));
      const result = await captureCli(["runtime", "start", "--mode", "route"], { ...f.deps, signal: new AbortController().signal });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "invalid_usage" } });
      expect(result.stdout).toBe("");
      expect(existsSync(join(f.run, "modeld.sock"))).toBe(false);
      expect(existsSync(join(f.root, "state/desired.json"))).toBe(false);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

test("cancel before runtime start performs no allocation or configuration write", async () => {
  const f = await fixture();
  const controller = new AbortController(); controller.abort();
  try {
    const result = await captureCli(["runtime", "start", "--mode", "observe"], { ...f.deps, signal: controller.signal });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("runtime_start_cancelled");
    expect(existsSync(f.root)).toBe(false);
    expect(existsSync(f.run)).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("runtime start output failure releases its service without rolling back saved intent", async () => {
  const f = await fixture();
  try {
    const result = await captureCli(["runtime", "start", "--mode", "observe"], {
      ...f.deps, signal: new AbortController().signal,
      stdout: { write() { throw new Error("owned_output_failure"); } },
    });
    expect(result.code).not.toBe(0);
    expect(existsSync(join(f.run, "modeld.sock"))).toBe(false);
    expect(JSON.parse(await readFile(join(f.root, "state/desired.json"), "utf8"))).toEqual({ version: 1, mode: "observe" });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
}, 3500);
